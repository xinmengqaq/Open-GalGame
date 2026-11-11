import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  readJsonDocument,
  writeJsonDocument,
  type StorageFailure
} from '@infrastructure/storage/jsonDocument'

import { assertWorkflowSegment, type WorkflowIdentity } from '../WorkflowIdentity'
import type { WorkflowOperationPhase } from '../WorkflowExecution'

const TEMPORARY_NAME_PREFIX = '.opengalgame-tmp-'

export const workflowStorageFailure: StorageFailure = {
  code: ErrorCodes.internalError,
  msg: '工作流状态读写失败'
}

/**
 * 确认状态根目录存在并返回真实路径。
 * @throws {AppException} 目录不是绝对路径，或无法创建。
 */
export async function ensureStateRoot(stateRoot: string): Promise<string> {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '状态目录必须是绝对路径' })
  }
  await mkdir(stateRoot, { recursive: true })
  return realpath(stateRoot)
}

/**
 * @returns 确认仍在根内的绝对路径。
 * @throws {AppException} 路径越界或指向链接外部。
 */
export async function resolveStatePath(stateRoot: string, relativePath: string): Promise<string> {
  return resolveContained(stateRoot, relativePath)
}

/**
 * 把检查点命名空间编码为单个路径片段。
 * @param namespace - LangGraph 检查点命名空间。空字符串表示根图。
 * @throws {AppException} 命名空间不是字符串或过长。
 */
export function namespaceToken(namespace: string): string {
  if (typeof namespace !== 'string' || namespace.includes('\0') || namespace.length > 512) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '检查点命名空间无效' })
  }
  if (namespace === '') return '_'
  return `n_${Buffer.from(namespace, 'utf8').toString('base64url')}`
}

/**
 * 从目录名还原命名空间。无法识别时返回 undefined。
 * @returns 命名空间；不是本存储写入的目录时为 undefined。
 */
export function namespaceFromToken(token: string): string | undefined {
  if (token === '_') return ''
  if (!token.startsWith('n_')) return undefined
  try {
    return Buffer.from(token.slice(2), 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * @throws {AppException} 标识不合法。
 */
export function branchCheckpointRelative(scope: {
  projectId: string
  threadId: string
  branchId: string
}): string {
  return `${threadRelative(scope)}/branches/${assertWorkflowSegment(scope.branchId, 'branchId')}/checkpoints`
}

/**
 * @param namespace - 检查点命名空间。
 * @throws {AppException} 标识或命名空间不合法。
 */
export function checkpointRelative(
  scope: { projectId: string; threadId: string; branchId: string },
  namespace: string,
  checkpointId: string
): string {
  return `${branchCheckpointRelative(scope)}/${namespaceToken(namespace)}/${assertWorkflowSegment(checkpointId, 'checkpointId')}.json`
}

/**
 * @param namespace - 检查点命名空间。
 * @param index - 写入序号，特殊写入可以为负数。
 * @throws {AppException} 标识不合法。
 */
export function writeRelative(
  scope: { projectId: string; threadId: string; branchId: string },
  namespace: string,
  checkpointId: string,
  index: number,
  taskId: string
): string {
  if (!Number.isSafeInteger(index)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '检查点写入序号无效' })
  }
  const taskToken = Buffer.from(taskId, 'utf8').toString('base64url')
  return `${branchCheckpointRelative(scope)}/${namespaceToken(namespace)}/writes/${assertWorkflowSegment(checkpointId, 'checkpointId')}/${index}__${taskToken}.json`
}

/**
 * @param contentId - 外置内容标识。
 * @throws {AppException} 标识不合法。
 */
export function externalContentRelative(
  scope: { projectId: string; threadId: string },
  contentId: string
): string {
  return `${threadRelative(scope)}/context/${assertWorkflowSegment(contentId, 'externalContentId')}`
}

/**
 * 打开指定项目线程的真实目录。线程目录本身是联接时拒绝。
 * @returns 线程真实目录。目录不存在时为 undefined。
 * @throws {AppException} 路径越出该线程。
 */
export async function openThreadDirectory(
  stateRoot: string,
  scope: { projectId: string; threadId: string }
): Promise<string | undefined> {
  const root = await ensureStateRoot(stateRoot)
  const relativePath = threadRelative(scope)
  const lexical = join(root, ...relativePath.split('/'))
  try {
    const stats = await lstat(lexical)
    if (stats.isSymbolicLink()) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
  }
  const real = await realpath(lexical)
  if (relative(root, real).replaceAll('\\', '/') !== relativePath) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  }
  return real
}

/**
 * 确认目标的真实路径仍在指定线程内。
 * @throws {AppException} 目标不存在，或真实路径越出线程。
 */
export async function resolveInsideThread(
  threadDirectory: string,
  target: string
): Promise<string> {
  let real: string
  try {
    real = await realpath(target)
  } catch (error) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围', cause: error })
  }
  if (!staysInside(threadDirectory, real)) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  }
  return real
}

/**
 * @throws {AppException} 路径或写入失败。
 */
export async function recordOperationPhase(
  stateRoot: string,
  identity: WorkflowIdentity,
  phase: WorkflowOperationPhase
): Promise<void> {
  const threadDirectory = await ensureThreadDirectory(stateRoot, identity)
  const operations = join(threadDirectory, 'operations')
  await mkdir(operations, { recursive: true })
  const directory = await resolveInsideThread(threadDirectory, operations)
  await writeJsonDocument(
    join(directory, `${identity.operationId}.json`),
    {
      phase,
      operationId: identity.operationId,
      branchId: identity.branchId
    },
    workflowStorageFailure
  )
}

/**
 * @returns 已记录的阶段。目录不存在时为空。
 * @throws {AppException} 阶段文件损坏或路径越界。
 */
export async function readOperationPhases(
  stateRoot: string,
  scope: { projectId: string; threadId: string }
): Promise<Array<{ operationId: string; branchId: string; phase: WorkflowOperationPhase }>> {
  const threadDirectory = await openThreadDirectory(stateRoot, scope)
  if (!threadDirectory) return []
  const directory = join(threadDirectory, 'operations')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const phases: Array<{ operationId: string; branchId: string; phase: WorkflowOperationPhase }> = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith(TEMPORARY_NAME_PREFIX)) continue
    const path = await resolveInsideThread(threadDirectory, join(directory, name))
    const value = await readJsonDocument(path, workflowStorageFailure)
    phases.push(parseOperationPhase(value))
  }
  return phases
}

/**
 * 用临时文件和原子改名写入字节。
 * @throws {AppException} 写入或改名失败。
 */
export async function writeAtomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `${TEMPORARY_NAME_PREFIX}${randomUUID()}`)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, bytes, { flag: 'wx', flush: true })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '工作流状态读写失败',
      cause: error
    })
  }
}

/**
 * 判断目标真实路径是否仍在根目录内。
 * @param root - 已解析的根目录。
 */
function staysInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

/**
 * 创建缺失的线程目录，并再次确认它没有被联接到其他线程。
 * @throws {AppException} 路径越出该线程。
 */
async function ensureThreadDirectory(
  stateRoot: string,
  scope: { projectId: string; threadId: string }
): Promise<string> {
  const existing = await openThreadDirectory(stateRoot, scope)
  if (existing) return existing
  const root = await ensureStateRoot(stateRoot)
  await mkdir(join(root, ...threadRelative(scope).split('/')), { recursive: true })
  const created = await openThreadDirectory(stateRoot, scope)
  if (!created) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  }
  return created
}

/**
 * @throws {AppException} 标识不合法。
 */
function threadRelative(scope: { projectId: string; threadId: string }): string {
  return `projects/${assertWorkflowSegment(scope.projectId, 'projectId')}/threads/${assertWorkflowSegment(scope.threadId, 'threadId')}`
}

/**
 * @throws {AppException} 文档缺少字段或阶段无法识别。
 */
function parseOperationPhase(value: unknown): {
  operationId: string
  branchId: string
  phase: WorkflowOperationPhase
} {
  if (!value || typeof value !== 'object') {
    throw new AppException({ code: ErrorCodes.internalError, msg: '操作状态已损坏' })
  }
  const record = value as { phase?: unknown; operationId?: unknown; branchId?: unknown }
  const phase = record.phase
  if (
    phase !== 'running' &&
    phase !== 'waiting' &&
    phase !== 'pendingRecovery' &&
    phase !== 'finished' &&
    phase !== 'cancelled' &&
    phase !== 'failed'
  ) {
    throw new AppException({ code: ErrorCodes.internalError, msg: '操作状态已损坏' })
  }
  return {
    phase,
    operationId: assertWorkflowSegment(
      typeof record.operationId === 'string' ? record.operationId : '',
      'operationId'
    ),
    branchId: assertWorkflowSegment(
      typeof record.branchId === 'string' ? record.branchId : '',
      'branchId'
    )
  }
}
