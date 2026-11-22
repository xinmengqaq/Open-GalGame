import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

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

export async function ensureStateRoot(stateRoot: string): Promise<string> {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '状态目录必须是绝对路径' })
  }
  await mkdir(stateRoot, { recursive: true })
  return realpath(stateRoot)
}

export async function resolveStatePath(stateRoot: string, relativePath: string): Promise<string> {
  return resolveContained(stateRoot, relativePath)
}

export function namespaceToken(namespace: string): string {
  if (typeof namespace !== 'string' || namespace.includes('\0') || namespace.length > 512) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '检查点命名空间无效' })
  }
  if (namespace === '') return '_'
  return `n_${Buffer.from(namespace, 'utf8').toString('base64url')}`
}

export function namespaceFromToken(token: string): string | undefined {
  if (token === '_') return ''
  if (!token.startsWith('n_')) return undefined
  try {
    return Buffer.from(token.slice(2), 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

export function branchCheckpointRelative(scope: {
  projectId: string
  threadId: string
  branchId: string
}): string {
  return `${threadRelative(scope)}/branches/${assertWorkflowSegment(scope.branchId, 'branchId')}/checkpoints`
}

export function checkpointRelative(
  scope: { projectId: string; threadId: string; branchId: string },
  namespace: string,
  checkpointId: string
): string {
  return `${branchCheckpointRelative(scope)}/${namespaceToken(namespace)}/${assertWorkflowSegment(checkpointId, 'checkpointId')}.json`
}

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

function staysInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

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

function threadRelative(scope: { projectId: string; threadId: string }): string {
  return `projects/${assertWorkflowSegment(scope.projectId, 'projectId')}/threads/${assertWorkflowSegment(scope.threadId, 'threadId')}`
}

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
