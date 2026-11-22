import { rm } from 'node:fs/promises'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { readJsonDocument, writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import {
  ensureStateRoot,
  resolveStatePath,
  workflowStorageFailure
} from '@infrastructure/workflow/checkpoints/checkpointPath'
import { createWorkflowIdentity } from '@infrastructure/workflow/WorkflowIdentity'

/**
 * 一次安全暂停的可恢复边界。只记录续做所需的事实，不保存候选正文或模型消息。
 * generation 对应执行记录的 attempt；恢复时代次必须恰好推进一次。
 */
export interface PiPauseBoundary {
  readonly projectId: string
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly checkpointId: string
  readonly generation: number
  /** 下一轮序号，等于本轮已完成并通过校验的候选写入次数。 */
  readonly pass: number
  /** 下一轮模式；第一轮沿用 firstMode，之后固定为 repair。 */
  readonly firstMode: 'generate' | 'repair'
  readonly mode: 'generate' | 'repair'
  /** 本轮开始前的候选；首轮输入摘要从这里起算。 */
  readonly baseCandidateSnapshotId?: string
  /** 暂停时的当前候选修订。 */
  readonly candidateSnapshotId?: string
  /** 下一轮输入的持久摘要，恢复时重新计算并核对。 */
  readonly inputDigest: string
  /** 暂停时入口草稿的内容摘要，恢复时磁盘草稿必须仍是它。 */
  readonly draftRevision: string
  /** 接受后自动修正的语义要在暂停后保留，避免恢复时降级成普通审阅。 */
  readonly reviewAccepted: boolean
  /** 已发布候选修订关系；恢复时只能在其基础上追加。 */
  readonly publishedCandidates: readonly string[]
  /** 保留的待执行回复；接受回复由 reviewAccepted 承接，不在此列。 */
  readonly pendingReplyId?: string
}

interface PauseBoundaryIdentity {
  readonly projectId: string
  readonly threadId: string
  readonly branchId: string
  readonly operationId: string
}

/** 每个操作只有一份当前暂停边界；再次暂停时原子覆盖。 */
export async function writePauseBoundary(
  stateRoot: string,
  boundary: PiPauseBoundary
): Promise<void> {
  const path = await pauseBoundaryPath(stateRoot, boundary)
  await writeJsonDocument(path, boundary, workflowStorageFailure)
}

/** @returns 当前暂停边界；不存在时为 null。 */
export async function readPauseBoundary(
  stateRoot: string,
  identity: PauseBoundaryIdentity
): Promise<PiPauseBoundary | null> {
  const path = await pauseBoundaryPath(stateRoot, identity)
  return asPauseBoundary(await readJsonDocument(path, workflowStorageFailure))
}

/** 显式继续到达可审阅/等待/失败边界后删除，避免旧边界影响后一次运行或崩溃恢复。 */
export async function clearPauseBoundary(
  stateRoot: string,
  identity: PauseBoundaryIdentity
): Promise<void> {
  const path = await pauseBoundaryPath(stateRoot, identity)
  await rm(path, { force: true })
}

async function pauseBoundaryPath(
  stateRoot: string,
  identity: PauseBoundaryIdentity
): Promise<string> {
  const checked = createWorkflowIdentity(identity)
  const root = await ensureStateRoot(stateRoot)
  return resolveStatePath(
    root,
    `projects/${checked.projectId}/threads/${checked.threadId}/operations/${checked.operationId}/pause-boundary.json`
  )
}

function asPauseBoundary(value: unknown): PiPauseBoundary | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw invalidBoundary()
  const record = value as Record<string, unknown>
  if (
    typeof record.projectId !== 'string' ||
    typeof record.operationId !== 'string' ||
    typeof record.threadId !== 'string' ||
    typeof record.branchId !== 'string' ||
    typeof record.checkpointId !== 'string' ||
    !isCount(record.generation) ||
    !isCount(record.pass) ||
    !isMode(record.firstMode) ||
    !isMode(record.mode) ||
    typeof record.inputDigest !== 'string' ||
    record.inputDigest === '' ||
    typeof record.draftRevision !== 'string' ||
    record.draftRevision === '' ||
    typeof record.reviewAccepted !== 'boolean' ||
    !Array.isArray(record.publishedCandidates) ||
    record.publishedCandidates.some((item) => typeof item !== 'string')
  )
    throw invalidBoundary()
  const optionalString = (field: unknown): string | undefined => {
    if (field === undefined) return undefined
    if (typeof field !== 'string' || field === '') throw invalidBoundary()
    return field
  }
  return {
    projectId: record.projectId,
    operationId: record.operationId,
    threadId: record.threadId,
    branchId: record.branchId,
    checkpointId: record.checkpointId,
    generation: record.generation,
    pass: record.pass,
    firstMode: record.firstMode,
    mode: record.mode,
    ...(record.baseCandidateSnapshotId === undefined
      ? {}
      : { baseCandidateSnapshotId: optionalString(record.baseCandidateSnapshotId) }),
    ...(record.candidateSnapshotId === undefined
      ? {}
      : { candidateSnapshotId: optionalString(record.candidateSnapshotId) }),
    inputDigest: record.inputDigest,
    draftRevision: record.draftRevision,
    reviewAccepted: record.reviewAccepted,
    publishedCandidates: record.publishedCandidates as string[],
    ...(record.pendingReplyId === undefined
      ? {}
      : { pendingReplyId: optionalString(record.pendingReplyId) })
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isMode(value: unknown): value is 'generate' | 'repair' {
  return value === 'generate' || value === 'repair'
}

function invalidBoundary(): AppException {
  return new AppException({ code: ErrorCodes.internalError, msg: '暂停边界记录损坏' })
}
