import { join } from 'node:path'

import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  getCheckpointId,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple
} from '@langchain/langgraph-checkpoint'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  isTemporaryDocumentName,
  listDocumentNames,
  readJsonDocument
} from '@infrastructure/storage/jsonDocument'

import { WorkflowError } from '../WorkflowError'
import {
  assertWorkflowSegment,
  scopeFromThreadKey,
  type WorkflowIdentity
} from '../WorkflowIdentity'
import {
  decodePayload,
  parseCheckpointEnvelope,
  parseWriteEnvelope,
  type CheckpointEnvelope
} from './checkpointCompatibility'
import {
  branchCheckpointRelative,
  checkpointRelative,
  ensureStateRoot,
  namespaceFromToken,
  namespaceToken,
  resolveStatePath,
  workflowStorageFailure
} from './checkpointPath'

interface Scope {
  projectId: string
  threadId: string
  branchId: string
}

/**
 * 只读打开旧 LangGraph 检查点，供历史列表与详情解码使用。
 * 不提供写入；旧生成运行时的写入路径已随运行时删除。
 */
export class ReadOnlyGenerationCheckpointStore extends BaseCheckpointSaver {
  private resolvedRoot?: string

  constructor(private readonly stateRoot: string) {
    super()
  }

  /**
   * 读取指定检查点；未指定标识时读取该命名空间最新的一份。
   * @param config - 库运行配置。只使用线程键、命名空间和检查点标识。
   * @returns 完整检查点、父关联和待完成写入。不存在时为 undefined。
   * @throws {WorkflowError | AppException} 检查点损坏、版本不兼容或路径越界。
   */
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const located = this.locate(config)
    if (!located) return undefined
    const checkpointId =
      located.checkpointId || (await this.latestId(located.scope, located.namespace))
    if (!checkpointId) return undefined
    return this.readTuple(located.threadKey, located.scope, located.namespace, checkpointId)
  }

  /**
   * 按时间倒序列出检查点。没有线程键时不扫描其他项目。
   * @throws {WorkflowError | AppException} 检查点损坏、版本不兼容或路径越界。
   */
  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const located = this.locate(config)
    if (!located) return
    const root = await this.root()
    const branch = await resolveStatePath(root, branchCheckpointRelative(located.scope))
    const namespaces = await listDocumentNames(branch, workflowStorageFailure)
    const requestedNs = config.configurable?.checkpoint_ns
    let remaining = options?.limit
    const beforeId = options?.before ? getCheckpointId(options.before) : ''
    for (const token of namespaces) {
      const namespace = namespaceFromToken(token)
      if (namespace === undefined) continue
      if (requestedNs !== undefined && namespace !== requestedNs) continue
      const files = await listDocumentNames(join(branch, token), workflowStorageFailure)
      const ids = files
        .filter((name) => name.endsWith('.json') && !isTemporaryDocumentName(name))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((id) => isCheckpointFileId(id))
        .sort((left, right) => right.localeCompare(left))
      for (const checkpointId of ids) {
        if (located.checkpointId && checkpointId !== located.checkpointId) continue
        if (beforeId && checkpointId >= beforeId) continue
        const tuple = await this.readTuple(
          located.threadKey,
          located.scope,
          namespace,
          checkpointId
        )
        if (!tuple) continue
        if (options?.filter && !matchesFilter(tuple.metadata, options.filter)) continue
        if (remaining !== undefined) {
          if (remaining <= 0) return
          remaining -= 1
        }
        yield tuple
      }
    }
  }

  override async put(): Promise<RunnableConfig> {
    throw this.readOnlyFailure()
  }

  override async putWrites(): Promise<void> {
    throw this.readOnlyFailure()
  }

  override async deleteThread(): Promise<void> {
    throw this.readOnlyFailure()
  }

  async readAssociation(
    identity: WorkflowIdentity,
    checkpointId: string,
    namespace = ''
  ): Promise<
    | {
        inputDigest?: string
        candidateRevision?: string
        externalContentIds?: readonly string[]
        operationId?: string
        revisionRef?: string
      }
    | undefined
  > {
    const envelope = await this.readEnvelope(identity, namespace, checkpointId)
    if (!envelope) return undefined
    return {
      ...(envelope.inputDigest !== undefined ? { inputDigest: envelope.inputDigest } : {}),
      ...(envelope.candidateRevision !== undefined
        ? { candidateRevision: envelope.candidateRevision }
        : {}),
      ...(envelope.externalContentIds !== undefined
        ? { externalContentIds: envelope.externalContentIds }
        : {}),
      ...(envelope.operationId !== undefined ? { operationId: envelope.operationId } : {}),
      ...(envelope.revisionRef !== undefined ? { revisionRef: envelope.revisionRef } : {})
    }
  }

  private readOnlyFailure(): AppException {
    return new AppException({
      code: ErrorCodes.internalError,
      msg: '只读检查点存储不支持写入'
    })
  }

  private locate(config: RunnableConfig):
    | {
        threadKey: string
        scope: Scope
        namespace: string
        checkpointId?: string
      }
    | undefined {
    const threadKey = config.configurable?.thread_id
    if (threadKey === undefined) return undefined
    if (typeof threadKey !== 'string') {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '工作流身份包含空值或非法路径片段'
      })
    }
    const namespace = config.configurable?.checkpoint_ns ?? ''
    namespaceToken(namespace)
    const checkpointId = getCheckpointId(config)
    return {
      threadKey,
      scope: scopeFromThreadKey(threadKey),
      namespace,
      ...(checkpointId ? { checkpointId: assertWorkflowSegment(checkpointId, 'checkpointId') } : {})
    }
  }

  /**
   * 找到命名空间中按标识排序最新的检查点。
   * @param namespace - 检查点命名空间。
   * @returns 检查点标识；没有检查点时为 undefined。
   * @throws {AppException} 路径越界或目录无法读取。
   */
  private async latestId(scope: Scope, namespace: string): Promise<string | undefined> {
    const root = await this.root()
    const directory = await resolveStatePath(
      root,
      `${branchCheckpointRelative(scope)}/${namespaceToken(namespace)}`
    )
    const names = await listDocumentNames(directory, workflowStorageFailure)
    const ids = names
      .filter((name) => name.endsWith('.json') && !isTemporaryDocumentName(name))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => isCheckpointFileId(id))
      .sort((left, right) => right.localeCompare(left))
    return ids[0]
  }

  private async readTuple(
    threadKey: string,
    scope: Scope,
    namespace: string,
    checkpointId: string
  ): Promise<CheckpointTuple | undefined> {
    const envelope = await this.readEnvelope(scope, namespace, checkpointId)
    if (!envelope) return undefined
    if (envelope.checkpointId !== checkpointId || envelope.checkpointNs !== namespace) {
      throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
    }
    const checkpoint = readCheckpoint(
      await loadSerde(
        this.serde,
        envelope.checkpointSerde.type,
        decodePayload(envelope.checkpointSerde.payload)
      ),
      checkpointId,
      envelope.checkpointVersion
    )
    const metadata = (await loadSerde(
      this.serde,
      envelope.metadataSerde.type,
      decodePayload(envelope.metadataSerde.payload)
    )) as CheckpointMetadata
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadKey,
          checkpoint_ns: namespace,
          checkpoint_id: checkpointId
        }
      },
      checkpoint,
      metadata,
      pendingWrites: await this.readWrites(scope, namespace, checkpointId)
    }
    if (envelope.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadKey,
          checkpoint_ns: namespace,
          checkpoint_id: envelope.parentCheckpointId
        }
      }
    }
    return tuple
  }

  private async readEnvelope(
    scope: Scope,
    namespace: string,
    checkpointId: string
  ): Promise<CheckpointEnvelope | undefined> {
    const root = await this.root()
    const path = await resolveStatePath(root, checkpointRelative(scope, namespace, checkpointId))
    const value = await readCheckpointDocument(path)
    if (value === null) return undefined
    return parseCheckpointEnvelope(value)
  }

  /**
   * @param namespace - 检查点命名空间。
   * @throws {WorkflowError | AppException} 写入文件损坏或路径越界。
   */
  private async readWrites(
    scope: Scope,
    namespace: string,
    checkpointId: string
  ): Promise<CheckpointPendingWrite[]> {
    const root = await this.root()
    const relativeDirectory = `${branchCheckpointRelative(scope)}/${namespaceToken(namespace)}/writes/${checkpointId}`
    const resolvedDirectory = await resolveStatePath(root, relativeDirectory)
    const names = await listDocumentNames(resolvedDirectory, workflowStorageFailure)
    const writes: CheckpointPendingWrite[] = []
    const files = names
      .filter((name) => /^-?\d+__[A-Za-z0-9_-]+\.json$/u.test(name))
      .sort(compareWriteFiles)
    for (const name of files) {
      const path = await resolveStatePath(root, `${relativeDirectory}/${name}`)
      const value = await readCheckpointDocument(path)
      if (value === null) continue
      const envelope = parseWriteEnvelope(value)
      const loaded = await loadSerde(
        this.serde,
        envelope.serde.type,
        decodePayload(envelope.serde.payload)
      )
      writes.push([envelope.taskId, envelope.channel, loaded])
    }
    return writes
  }

  private async root(): Promise<string> {
    this.resolvedRoot ??= await ensureStateRoot(this.stateRoot)
    return this.resolvedRoot
  }
}

async function readCheckpointDocument(path: string): Promise<unknown | null> {
  try {
    return await readJsonDocument(path, { code: ErrorCodes.internalError, msg: '检查点已损坏' })
  } catch (error) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏', cause: error })
  }
}

async function loadSerde(
  serde: { loadsTyped(type: string, data: Uint8Array): Promise<unknown> },
  type: string,
  bytes: Uint8Array
): Promise<unknown> {
  try {
    return await serde.loadsTyped(type, bytes)
  } catch (error) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏', cause: error })
  }
}

function readCheckpoint(
  value: unknown,
  checkpointId: string,
  checkpointVersion: number
): Checkpoint {
  if (!isPlainRecord(value)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  if (
    value.v !== checkpointVersion ||
    value.id !== checkpointId ||
    typeof value.ts !== 'string' ||
    !isPlainRecord(value.channel_values) ||
    !isPlainRecord(value.channel_versions) ||
    !isPlainRecord(value.versions_seen)
  ) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value as unknown as Checkpoint
}

function compareWriteFiles(left: string, right: string): number {
  const leftParts = splitWriteFile(left)
  const rightParts = splitWriteFile(right)
  if (leftParts.task !== rightParts.task) return leftParts.task < rightParts.task ? -1 : 1
  return leftParts.index - rightParts.index
}

function splitWriteFile(name: string): { index: number; task: string } {
  const separator = name.indexOf('__')
  return {
    index: Number(name.slice(0, separator)),
    task: name.slice(separator + 2)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCheckpointFileId(checkpointId: string): boolean {
  try {
    assertWorkflowSegment(checkpointId, 'checkpointId')
    return true
  } catch {
    return false
  }
}

function matchesFilter(
  metadata: CheckpointMetadata | undefined,
  filter: Record<string, unknown>
): boolean {
  if (!metadata) return false
  return Object.entries(filter).every(([key, value]) => metadata[key] === value)
}
