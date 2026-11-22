import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution,
  SceneGenerationRepairContext
} from '../models/SceneGenerationExecution'
import type { SceneGenerationReplyDTO } from '../dto/SceneGenerationDTO'

const CONFIRMED_REPLY_LIMIT = 64
const UNRESOLVED_ISSUE_LIMIT = 100
const UNRESOLVED_ISSUE_LENGTH_LIMIT = 500
const MISSING_SOURCE = '修复上下文缺少来源身份，不能继续本次修复'
const SOURCE_MISMATCH = '修复来源身份与上下文不一致，不能继续本次修复'
const INCOMPLETE_CONTEXT = '修复来源上下文不完整，不能继续本次修复'
const CONTEXT_TOO_LARGE = '来源修复上下文过大，已保留原失败记录'

export function buildSceneGenerationRepairContext(
  source: SceneGenerationExecution,
  checkpoint: SceneGenerationCheckpoint,
  instruction: string
): SceneGenerationRepairContext | undefined {
  if (!source.checkpointId || !source.candidateSnapshotId) return undefined
  if (checkpoint.execution.operationId !== source.operationId) return undefined
  if (checkpoint.candidateSnapshotId !== source.candidateSnapshotId) return undefined
  const trimmed = instruction.trim()
  if (trimmed === '') return undefined
  const previous = source.repairContext
  const confirmedReplies = [
    ...(previous?.confirmedReplies ?? []),
    ...source.replies.flatMap((reply) => {
      const body = confirmedBody(reply.reply)
      return body ? [{ kind: reply.reply.kind as 'revise' | 'clarify', body }] : []
    }),
    { kind: 'revise' as const, body: trimmed }
  ]
  const seen = new Set<string>()
  const deduplicated = confirmedReplies.filter((reply) => {
    const key = `${reply.kind}\u0000${reply.body}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const summary =
    checkpoint.summary !== undefined ? checkpoint.summary.trim() : (previous?.summary ?? '')
  const unresolvedIssues =
    checkpoint.unresolvedIssues !== undefined
      ? [...checkpoint.unresolvedIssues]
      : [...(previous?.unresolvedIssues ?? [])]
  if (
    unresolvedIssues.length > UNRESOLVED_ISSUE_LIMIT ||
    unresolvedIssues.some((issue) => issue.length > UNRESOLVED_ISSUE_LENGTH_LIMIT)
  )
    throw new AppException({ code: ErrorCodes.operationConflict, msg: CONTEXT_TOO_LARGE })
  return {
    sourceOperationId: source.operationId,
    sourceThreadId: source.threadId,
    sourceBranchId: source.branchId,
    sourceCheckpointId: source.checkpointId,
    sourceCandidateSnapshotId: source.candidateSnapshotId,
    candidatePath: `${source.source.sceneDirectory}/${source.source.entryFile}`,
    instruction: trimmed,
    summary,
    unresolvedIssues,
    validationReport: source.artifactValidation ?? previous?.validationReport,
    failureClass: source.failure?.failureClass ?? previous?.failureClass,
    failureReason: source.failure?.reason ?? previous?.failureReason,
    failureMessage: source.failure?.message ?? previous?.failureMessage,
    confirmedReplies: deduplicated.slice(-CONFIRMED_REPLY_LIMIT)
  }
}

export function repairContextIssue(execution: SceneGenerationExecution): string | undefined {
  const context = execution.repairContext
  if (!context) return undefined
  const source = execution.repairSource
  if (!source) return MISSING_SOURCE
  if (
    source.operationId !== context.sourceOperationId ||
    source.threadId !== context.sourceThreadId ||
    source.branchId !== context.sourceBranchId ||
    source.checkpointId !== context.sourceCheckpointId ||
    source.candidateSnapshotId !== context.sourceCandidateSnapshotId
  )
    return SOURCE_MISMATCH
  if (context.instruction.trim() === '' || context.candidatePath.trim() === '') {
    return INCOMPLETE_CONTEXT
  }
  if (
    context.candidatePath !== `${execution.source.sceneDirectory}/${execution.source.entryFile}`
  ) {
    return INCOMPLETE_CONTEXT
  }
  return undefined
}

function confirmedBody(reply: SceneGenerationReplyDTO): string | undefined {
  if (reply.kind !== 'revise' && reply.kind !== 'clarify') return undefined
  const body = reply.body.trim()
  return body === '' ? undefined : body
}
