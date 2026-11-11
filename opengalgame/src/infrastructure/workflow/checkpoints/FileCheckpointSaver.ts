import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite
} from '@langchain/langgraph-checkpoint'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  isTemporaryDocumentName,
  listDocumentNames,
  readJsonDocument,
  writeJsonDocument
} from '@infrastructure/storage/jsonDocument'

import { assertRevisionToken } from '../CheckpointReference'
import { currentCheckpointCompatibility } from '../CheckpointCompatibility'
import { WorkflowError } from '../WorkflowError'
import {
  assertWorkflowSegment,
  scopeFromThreadKey,
  type WorkflowIdentity
} from '../WorkflowIdentity'
import {
  checkpointMetadataForStorage,
  decodePayload,
  encodePayload,
  parseCheckpointEnvelope,
  parseWriteEnvelope,
  type CheckpointEnvelope
} from './checkpointCompatibility'
import {
  branchCheckpointRelative,
  checkpointRelative,
  ensureStateRoot,
  externalContentRelative,
  namespaceFromToken,
  namespaceToken,
  resolveStatePath,
  workflowStorageFailure,
  writeAtomicBytes,
  writeRelative
} from './checkpointPath'

interface Scope {
  projectId: string
  threadId: string
  branchId: string
}

/** 按项目、线程和分支保存 LangGraph 检查点。直接实现当前库的存储协议。 */
export class FileCheckpointSaver extends BaseCheckpointSaver {
  private resolvedRoot?: string

  /**
   * @param serde - 库序列化协议。省略时使用基类的当前实现。
   */
  constructor(
    private readonly stateRoot: string,
    serde?: ConstructorParameters<typeof BaseCheckpointSaver>[0]
  ) {
    super(serde)
  }

  /**
   * 读取指定检查点；未指定标识时读取该命名空间最新的一份。
   * @param config - 库运行配置。只使用线程键、命名空间和检查点标识。
   * @returns 完整检查点、父关联和待完成写入。不存在时为 undefined。
   * @throws {WorkflowError | AppException} 检查点损坏、版本不兼容或路径越界。
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
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
  async *list(
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

  /**
   * @returns 只含线程键、命名空间和检查点标识的配置。
   * @throws {WorkflowError | AppException} 身份、路径或写入失败。
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, number | string>
  ): Promise<RunnableConfig> {
    void newVersions
    const located = this.requireLocation(config)
    assertWorkflowSegment(checkpoint.id, 'checkpointId')
    const prepared = copyCheckpoint(checkpoint)
    const storedMetadata = checkpointMetadataForStorage(metadata)
    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(storedMetadata)
    ])
    const parentCheckpointId = config.configurable?.checkpoint_id
    const envelope: CheckpointEnvelope = {
      ...currentCheckpointCompatibility(),
      checkpointVersion: prepared.v,
      checkpointNs: located.namespace,
      checkpointId: prepared.id,
      checkpointSerde: encodePayload(checkpointType, checkpointBytes),
      metadataSerde: encodePayload(metadataType, metadataBytes)
    }
    if (typeof parentCheckpointId === 'string' && parentCheckpointId.length > 0) {
      envelope.parentCheckpointId = assertWorkflowSegment(parentCheckpointId, 'parentCheckpointId')
    }
    await this.writeEnvelope(located.scope, located.namespace, prepared.id, envelope)
    return {
      configurable: {
        thread_id: located.threadKey,
        checkpoint_ns: located.namespace,
        checkpoint_id: prepared.id
      }
    }
  }

  /**
   * 保存检查点上的待完成写入。已完成的普通写入不覆盖。
   * @param config - 必须包含线程键和检查点标识。
   * @throws {WorkflowError | AppException} 配置缺失、路径越界或写入失败。
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const located = this.requireLocation(config)
    if (!located.checkpointId) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '保存检查点写入时缺少检查点标识'
      })
    }
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.includes('\0')) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '检查点任务标识无效' })
    }
    await Promise.all(
      writes.map(async ([channel, value], position) => {
        const index = WRITES_IDX_MAP[channel] || position
        const relative = writeRelative(
          located.scope,
          located.namespace,
          located.checkpointId!,
          index,
          taskId
        )
        const root = await this.root()
        const path = await resolveStatePath(root, relative)
        if (index >= 0) {
          const existing = await readJsonDocument(path, workflowStorageFailure)
          if (existing !== null) return
        }
        const [type, bytes] = await this.serde.dumpsTyped(value)
        await writeJsonDocument(
          path,
          {
            ...currentCheckpointCompatibility(),
            taskId,
            index,
            channel,
            serde: encodePayload(type, bytes)
          },
          workflowStorageFailure
        )
      })
    )
  }

  /**
   * 删除该内部线程键对应分支的检查点。不删除其他分支、线程或正式工程。
   * @throws {AppException} 线程键或路径不合法。
   */
  async deleteThread(threadId: string): Promise<void> {
    const scope = scopeFromThreadKey(threadId)
    const root = await this.root()
    const directory = await resolveStatePath(root, branchCheckpointRelative(scope))
    await rm(directory, { recursive: true, force: true })
  }

  /**
   * 给已保存的检查点关联输入摘要、候选修订和外置内容。不改动库状态载荷。
   * @param namespace - 检查点命名空间。省略时为根图。
   * @throws {WorkflowError | AppException} 检查点不存在、引用无效或写入失败。
   */
  async associate(
    identity: WorkflowIdentity,
    checkpointId: string,
    association: {
      inputDigest?: string
      candidateRevision?: string
      externalContentIds?: readonly string[]
      operationId?: string
    },
    namespace = ''
  ): Promise<void> {
    const envelope = await this.readEnvelope(identity, namespace, checkpointId)
    if (!envelope) {
      throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
    }
    if (association.inputDigest !== undefined) {
      if (
        association.inputDigest.length === 0 ||
        association.inputDigest.length > 256 ||
        /[\\/\0]/u.test(association.inputDigest)
      ) {
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '输入摘要无效' })
      }
      envelope.inputDigest = association.inputDigest
    }
    if (association.operationId !== undefined) {
      envelope.operationId = assertWorkflowSegment(association.operationId, 'operationId')
    }
    if (association.externalContentIds !== undefined) {
      envelope.externalContentIds = association.externalContentIds.map((id) =>
        assertWorkflowSegment(id, 'externalContentId')
      )
    }
    if (association.candidateRevision !== undefined) {
      const revision = assertRevisionToken(association.candidateRevision)
      envelope.candidateRevision = revision
      envelope.revisionRef = revision
    }
    await this.writeEnvelope(identity, namespace, checkpointId, envelope)
  }

  /**
   * 读取检查点信封上的不可变引用。不读取 Git 修订库。
   * @param namespace - 检查点命名空间。省略时为根图。
   * @returns 输入摘要、候选修订和外置内容。检查点不存在时为 undefined。
   * @throws {WorkflowError | AppException} 信封损坏或路径越界。
   */
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

  /**
   * 把外置内容写入线程的 context 目录。不复制工程。
   * @param contentId - 外置内容标识。
   * @throws {AppException} 标识或路径不合法。
   */
  async writeExternalContent(
    identity: WorkflowIdentity,
    contentId: string,
    bytes: Uint8Array
  ): Promise<void> {
    const root = await this.root()
    const path = await resolveStatePath(root, externalContentRelative(identity, contentId))
    await writeAtomicBytes(path, bytes)
  }

  /**
   * 解析库配置中的作用域。没有线程键时不猜测项目。
   * @throws {AppException} 线程键或检查点标识不合法。
   */
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
   * @throws {AppException} 缺少线程键或标识不合法。
   */
  private requireLocation(config: RunnableConfig): {
    threadKey: string
    scope: Scope
    namespace: string
    checkpointId?: string
  } {
    const located = this.locate(config)
    if (!located) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '保存检查点时缺少线程标识'
      })
    }
    return located
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

  /**
   * @param namespace - 检查点命名空间。
   * @returns 库要求的检查点元组。文件不存在时为 undefined。
   * @throws {WorkflowError | AppException} 检查点损坏或版本不兼容。
   */
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

  /**
   * @param namespace - 检查点命名空间。
   * @returns 信封；文件不存在时为 undefined。
   * @throws {WorkflowError | AppException} 文件损坏、缺字段或路径越界。
   */
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
   * @throws {WorkflowError | AppException} 写入失败或路径越界。
   */
  private async writeEnvelope(
    scope: Scope,
    namespace: string,
    checkpointId: string,
    envelope: CheckpointEnvelope
  ): Promise<void> {
    const root = await this.root()
    const path = await resolveStatePath(root, checkpointRelative(scope, namespace, checkpointId))
    try {
      await writeJsonDocument(path, envelope, workflowStorageFailure)
    } catch (error) {
      if (error instanceof AppException) {
        throw new WorkflowError({
          category: 'executionFailed',
          msg: '工作流检查点写入失败',
          cause: error
        })
      }
      throw error
    }
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

  /**
   * @throws {AppException} 目录无法创建。
   */
  private async root(): Promise<string> {
    this.resolvedRoot ??= await ensureStateRoot(this.stateRoot)
    return this.resolvedRoot
  }
}

/**
 * 在磁盘读取边界统一转换检查点与待写入文档的解析失败。
 * @returns 文档内容；不存在时为 null。
 * @throws {WorkflowError} 文档读取或解析失败，原始原因保留在 cause。
 */
async function readCheckpointDocument(path: string): Promise<unknown | null> {
  try {
    return await readJsonDocument(path, { code: ErrorCodes.internalError, msg: '检查点已损坏' })
  } catch (error) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏', cause: error })
  }
}

/**
 * 用注入的序列化器还原载荷，并把解析失败收成检查点损坏。
 * @throws {WorkflowError} 序列化器拒绝该类型或载荷。
 */
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

/**
 * @throws {WorkflowError} 缺少恢复字段，或标识、版本与信封不一致。
 */
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

/** 按任务标识和数值序号排列待完成写入，避免文件名字典序把 10 排到 2 前面。 */
function compareWriteFiles(left: string, right: string): number {
  const leftParts = splitWriteFile(left)
  const rightParts = splitWriteFile(right)
  if (leftParts.task !== rightParts.task) return leftParts.task < rightParts.task ? -1 : 1
  return leftParts.index - rightParts.index
}

/** 拆开写入文件名中的序号和任务片段。 */
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

/** 判断文件名是不是检查点标识。 */
function isCheckpointFileId(checkpointId: string): boolean {
  try {
    assertWorkflowSegment(checkpointId, 'checkpointId')
    return true
  } catch {
    return false
  }
}

/**
 * @param filter - 调用方给出的等值条件。
 */
function matchesFilter(
  metadata: CheckpointMetadata | undefined,
  filter: Record<string, unknown>
): boolean {
  if (!metadata) return false
  return Object.entries(filter).every(([key, value]) => metadata[key] === value)
}
