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

async function existingWrites(
  threadDirectory: string,
  namespaceDir: string,
  checkpointId: string
): Promise<string[]> {
  const path = join(namespaceDir, 'writes', checkpointId)
  const existing = await optionalInsideThread(threadDirectory, path)
  return existing ? [existing] : []
}

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

function staysInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

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
