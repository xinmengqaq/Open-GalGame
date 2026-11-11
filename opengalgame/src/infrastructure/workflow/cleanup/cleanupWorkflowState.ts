import { readdir, realpath, rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { isTemporaryDocumentName, readJsonDocument } from '@infrastructure/storage/jsonDocument'

import { WorkflowError } from '../WorkflowError'
import { assertWorkflowSegment } from '../WorkflowIdentity'
import { parseCheckpointEnvelope } from '../checkpoints/checkpointCompatibility'
import {
  namespaceFromToken,
  openThreadDirectory,
  readOperationPhases,
  resolveInsideThread,
  workflowStorageFailure
} from '../checkpoints/checkpointPath'

const BLOCKING_PHASES = new Set(['running', 'waiting', 'pendingRecovery'])

export interface CleanupWorkflowStateResult {
  removed: readonly string[]
}

/**
 * 按引用关系清理一个线程里的检查点、外置内容和临时工作区。
 * 仍被其他检查点或分支引用的文件会保留。不触碰正式工程、Git 历史或其他线程。
 * @throws {AppException} 线程仍有运行中、等待人工或待恢复操作。
 * @throws {WorkflowError} 删除失败。异常保留原始原因和已完成的路径。
 */
export async function cleanupWorkflowState(input: {
  stateRoot: string
  projectId: string
  threadId: string
  branchIds: readonly string[]
  projectRoot?: string
  removeFile?: (path: string) => Promise<void>
}): Promise<CleanupWorkflowStateResult> {
  const projectId = assertWorkflowSegment(input.projectId, 'projectId')
  const threadId = assertWorkflowSegment(input.threadId, 'threadId')
  const branchIds = input.branchIds.map((branchId) => assertWorkflowSegment(branchId, 'branchId'))
  const threadDirectory = await openThreadDirectory(input.stateRoot, { projectId, threadId })
  if (!threadDirectory) return { removed: [] }
  const phases = await readOperationPhases(input.stateRoot, { projectId, threadId })
  if (phases.some((phase) => BLOCKING_PHASES.has(phase.phase))) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '线程仍有运行中、等待人工或待恢复操作，不能清理'
    })
  }
  const checkpoints = await readThreadCheckpoints(threadDirectory)
  const removal = checkpoints.filter((item) => branchIds.includes(item.branchId))
  const kept = checkpoints.filter((item) => !branchIds.includes(item.branchId))
  const retainedIds = ancestorIds(checkpoints, kept)
  const removedCheckpoints = removal.filter((item) => !retainedIds.has(item.checkpointId))
  const remaining = checkpoints.filter(
    (item) => !removedCheckpoints.some((removed) => removed.path === item.path)
  )
  const referencedContent = new Set(remaining.flatMap((item) => item.externalContentIds))
  const referencedOperations = new Set(
    remaining.flatMap((item) => (item.operationId ? [item.operationId] : []))
  )
  const targets = [
    ...removedCheckpoints.flatMap((item) => [item.path, ...item.writes]),
    ...(await unreferencedChildren(threadDirectory, 'context', referencedContent)),
    ...(await unreferencedChildren(threadDirectory, 'workspaces', referencedOperations))
  ]
  if (remaining.length === 0) {
    const revisions = await optionalInsideThread(
      threadDirectory,
      join(threadDirectory, 'revisions')
    )
    if (revisions) targets.push(revisions)
  }
  const resolved = await Promise.all(
    [...new Set(targets)]
      .sort()
      .map((path) => resolveDeletable(threadDirectory, input.projectRoot, path))
  )
  const removeFile = input.removeFile ?? removeStoredFile
  const removed: string[] = []
  for (const path of resolved) {
    try {
      await removeFile(path)
      removed.push(path)
    } catch (error) {
      throw new WorkflowError({
        category: 'cleanupFailed',
        msg: '工作流状态清理失败',
        cause: error,
        completed: removed
      })
    }
  }
  return { removed }
}

/**
 * 沿保留检查点的父链收集全部祖先，而不是只保留直接父检查点。
 * @param kept - 不在本次删除分支中的检查点。
 * @returns 不能删除的检查点标识。
 */
function ancestorIds(
  checkpoints: readonly StoredCheckpoint[],
  kept: readonly StoredCheckpoint[]
): Set<string> {
  const parents = new Map<string, string | undefined>()
  for (const item of checkpoints) {
    if (!parents.has(item.checkpointId)) parents.set(item.checkpointId, item.parentCheckpointId)
  }
  const retained = new Set<string>()
  const pending = kept.flatMap((item) => (item.parentCheckpointId ? [item.parentCheckpointId] : []))
  while (pending.length > 0) {
    const id = pending.pop()
    if (!id || retained.has(id)) continue
    retained.add(id)
    const parent = parents.get(id)
    if (parent) pending.push(parent)
  }
  return retained
}

interface StoredCheckpoint {
  branchId: string
  checkpointId: string
  path: string
  writes: string[]
  parentCheckpointId?: string
  externalContentIds: readonly string[]
  operationId?: string
}

/**
 * 读取线程内所有分支的检查点信封。枚举项先核对真实路径仍在该线程内。
 * @throws {WorkflowError | AppException} 信封损坏或路径越界。
 */
async function readThreadCheckpoints(threadDirectory: string): Promise<StoredCheckpoint[]> {
  const branches = join(threadDirectory, 'branches')
  let branchNames: string[]
  try {
    branchNames = await readdir(branches)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const checkpoints: StoredCheckpoint[] = []
  for (const branchId of branchNames) {
    if (!isSegment(branchId)) continue
    const checkpointRoot = await optionalInsideThread(
      threadDirectory,
      join(branches, branchId, 'checkpoints')
    )
    if (!checkpointRoot) continue
    let namespaces: string[]
    try {
      namespaces = await readdir(checkpointRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const token of namespaces) {
      if (namespaceFromToken(token) === undefined) continue
      const namespaceDir = await optionalInsideThread(threadDirectory, join(checkpointRoot, token))
      if (!namespaceDir) continue
      const files = await readdir(namespaceDir).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      for (const name of files) {
        if (!name.endsWith('.json') || isTemporaryDocumentName(name)) continue
        const checkpointId = name.slice(0, -'.json'.length)
        if (!isSegment(checkpointId)) continue
        const path = await resolveInsideThread(threadDirectory, join(namespaceDir, name))
        const value = await readJsonDocument(path, workflowStorageFailure)
        if (value === null) continue
        const envelope = parseCheckpointEnvelope(value)
        const writes = await existingWrites(threadDirectory, namespaceDir, checkpointId)
        checkpoints.push({
          branchId,
          checkpointId,
          path,
          writes,
          externalContentIds: envelope.externalContentIds ?? [],
          ...(envelope.parentCheckpointId
            ? { parentCheckpointId: envelope.parentCheckpointId }
            : {}),
          ...(envelope.operationId ? { operationId: envelope.operationId } : {})
        })
      }
    }
  }
  return checkpoints
}

/**
 * 找到检查点对应的待写入目录。目录不存在时为空。
 * @param namespaceDir - 命名空间真实目录。
 * @throws {AppException} 写入目录越出线程。
 */
async function existingWrites(
  threadDirectory: string,
  namespaceDir: string,
  checkpointId: string
): Promise<string[]> {
  const path = join(namespaceDir, 'writes', checkpointId)
  const existing = await optionalInsideThread(threadDirectory, path)
  return existing ? [existing] : []
}

/**
 * 解析线程内路径。目标不存在时返回 undefined，越界仍失败。
 * @returns 真实路径；不存在时为 undefined。
 * @throws {AppException} 真实路径越出线程。
 */
async function optionalInsideThread(
  threadDirectory: string,
  target: string
): Promise<string | undefined> {
  try {
    return await resolveInsideThread(threadDirectory, target)
  } catch (error) {
    if (
      error instanceof AppException &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
}

/**
 * 找出目录中不再被引用的文件。
 * @param folder - 外置内容或临时工作区目录。
 * @param referenced - 仍被引用的标识。
 * @throws {AppException} 路径越界。
 */
async function unreferencedChildren(
  threadDirectory: string,
  folder: 'context' | 'workspaces',
  referenced: ReadonlySet<string>
): Promise<string[]> {
  const directory = join(threadDirectory, folder)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const paths: string[] = []
  for (const name of names) {
    if (isTemporaryDocumentName(name) || referenced.has(name)) continue
    paths.push(await resolveInsideThread(threadDirectory, join(directory, name)))
  }
  return paths
}

/**
 * 解析可删除目标，并确认真实路径属于当前线程且不进入正式工程。
 * @throws {AppException} 路径越出线程或进入正式工程。
 */
async function resolveDeletable(
  threadDirectory: string,
  projectRoot: string | undefined,
  target: string
): Promise<string> {
  const real = await resolveInsideThread(threadDirectory, target)
  if (!projectRoot) return real
  let projectReal = projectRoot
  try {
    projectReal = await realpath(projectRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
    }
  }
  if (staysInside(projectReal, real) || staysInside(real, projectReal)) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  }
  return real
}

/**
 * @param root - 根目录。
 */
function staysInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

/**
 * 删除文件或目录。文件不存在时不失败。
 * @throws {Error} 文件系统拒绝删除。
 */
async function removeStoredFile(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

function isSegment(value: string): boolean {
  try {
    assertWorkflowSegment(value, 'segment')
    return true
  } catch {
    return false
  }
}
