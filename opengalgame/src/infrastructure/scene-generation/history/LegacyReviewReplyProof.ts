import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'

const SUPPORTED_REVIEW_REPLIES: Record<string, true> = {
  accept: true,
  revise: true,
  discard: true
}

export interface LegacyReviewReplyEvidence {
  readonly replyable: boolean
  readonly reason?: string
}

/**
 * 旧 LangGraph 审阅边界没有 canReply。只有当前执行记录、检查点、输入、候选、
 * 工作区、写账本和审阅授权都能相互证明时才允许回复；任何一项算不出都拒绝。
 */
export function assessLegacyReviewReply(input: {
  readonly checkpointId: string
  readonly checkpointExecution: SceneGenerationExecution
  readonly checkpointTimestamp?: string
  readonly record?: SceneGenerationExecution
  readonly checkpointContinuable: boolean
  readonly inputDigestProven: boolean
  readonly candidateRevisionProven: boolean
  readonly workspaceMatchesRevision: boolean
  readonly entryPresent: boolean
  readonly effects: readonly DurableEffectRecord[]
}): LegacyReviewReplyEvidence {
  const candidateSnapshotId = input.checkpointExecution.candidateSnapshotId
  if (!input.checkpointContinuable)
    return { replyable: false, reason: '检查点本身不能继续' }
  if (!candidateSnapshotId) return { replyable: false, reason: '等待审阅缺少候选修订' }
  const record = input.record
  if (!record) return { replyable: false, reason: '旧等待缺少当前执行记录' }
  if (
    record.projectId !== input.checkpointExecution.projectId ||
    record.sceneId !== input.checkpointExecution.sceneId ||
    record.operationId !== input.checkpointExecution.operationId ||
    record.threadId !== input.checkpointExecution.threadId ||
    record.branchId !== input.checkpointExecution.branchId
  )
    return { replyable: false, reason: '执行记录身份与检查点不一致' }
  if (record.checkpointId !== input.checkpointId)
    return { replyable: false, reason: '执行记录未绑定该检查点' }
  if (record.candidateSnapshotId !== candidateSnapshotId)
    return { replyable: false, reason: '执行记录候选与检查点不一致' }
  if (!input.candidateRevisionProven)
    return { replyable: false, reason: '候选修订缺失或损坏' }
  if (!input.workspaceMatchesRevision)
    return { replyable: false, reason: '候选工作区与不可变修订不一致' }
  if (!input.entryPresent)
    return { replyable: false, reason: '候选修订缺少入口脚本' }
  if (!input.inputDigestProven)
    return { replyable: false, reason: '输入或候选摘要与检查点不一致' }
  if (!trustedWaitTime(record, input.checkpointExecution, input.checkpointTimestamp))
    return { replyable: false, reason: '等待缺少可信时间事实' }
  if (!legacyCandidateWriteProven(input.effects, candidateSnapshotId))
    return { replyable: false, reason: '写账本未证明当前候选已完整写入' }
  return reviewAuthorization(record, input.checkpointId, candidateSnapshotId)
}

function trustedWaitTime(
  record: SceneGenerationExecution,
  checkpointExecution: SceneGenerationExecution,
  checkpointTimestamp?: string
): boolean {
  const created = Date.parse(record.createdAt ?? '')
  const updated = Date.parse(record.updatedAt ?? '')
  const checkpointUpdated = Date.parse(checkpointExecution.updatedAt ?? '')
  const snapshot = Date.parse(checkpointTimestamp ?? '')
  if (![created, updated, checkpointUpdated, snapshot].every(Number.isFinite)) return false
  if (checkpointExecution.createdAt !== record.createdAt) return false
  return created <= checkpointUpdated && checkpointUpdated <= snapshot && snapshot <= updated
}

export function legacyCandidateWriteProven(
  effects: readonly DurableEffectRecord[],
  candidateSnapshotId: string
): boolean {
  if (effects.some((effect) => effect.kind === 'commit')) return false
  const writes = effects.filter((effect) => effect.kind === 'fileWrite')
  if (writes.length === 0) return false
  if (
    writes.some(
      (effect) =>
        effect.status !== 'completed' ||
        effect.candidateRevision === undefined ||
        effect.resultDigest === undefined
    )
  )
    return false
  return writes.some(
    (effect) =>
      effect.candidateRevision === candidateSnapshotId &&
      effect.resultDigest === candidateSnapshotId
  )
}

function reviewAuthorization(
  record: SceneGenerationExecution,
  checkpointId: string,
  candidateSnapshotId: string
): LegacyReviewReplyEvidence {
  const interaction = record.interaction
  if (record.state === 'waiting') {
    if (record.pendingReply !== undefined)
      return { replyable: false, reason: '等待记录带有未结算回复' }
    if (!interaction) return { replyable: false, reason: '等待缺少审阅授权' }
    if (interaction.kind !== 'review') return { replyable: false, reason: '等待不是候选审阅' }
    if (interaction.checkpointId !== checkpointId)
      return { replyable: false, reason: '审阅授权未绑定该检查点' }
    if (interaction.candidateSnapshotId !== candidateSnapshotId)
      return { replyable: false, reason: '审阅授权未绑定当前候选' }
    const allowed = interaction.allowedReplies
    if (allowed.length === 0) return { replyable: false, reason: '审阅授权没有允许动作' }
    if (allowed.some((kind) => SUPPORTED_REVIEW_REPLIES[kind] !== true))
      return { replyable: false, reason: '审阅授权包含未支持的动作' }
    if (!allowed.includes('accept')) return { replyable: false, reason: '审阅授权缺少接受动作' }
    return { replyable: true }
  }
  if (
    (record.state === 'pending' || record.state === 'running') &&
    record.pendingReply !== undefined
  ) {
    const pending = record.pendingReply
    if (pending.reply.kind === 'discard')
      return { replyable: false, reason: '丢弃回复不重放生成' }
    if (SUPPORTED_REVIEW_REPLIES[pending.reply.kind] !== true)
      return { replyable: false, reason: '待执行回复不是审阅动作' }
    if (pending.checkpointId !== checkpointId)
      return { replyable: false, reason: '待执行回复未绑定该检查点' }
    if (pending.candidateSnapshotId !== candidateSnapshotId)
      return { replyable: false, reason: '待执行回复未绑定当前候选' }
    if (
      !record.replies.some(
        (reply) =>
          reply.replyId === pending.replyId && reply.interactionId === pending.interactionId
      )
    )
      return { replyable: false, reason: '待执行回复未可靠保存' }
    if (
      interaction !== undefined &&
      (interaction.interactionId !== pending.interactionId ||
        interaction.checkpointId !== checkpointId ||
        interaction.candidateSnapshotId !== candidateSnapshotId)
    )
      return { replyable: false, reason: '审阅授权与待执行回复不一致' }
    return { replyable: true }
  }
  return { replyable: false, reason: '当前执行状态不处于可重开的审阅等待' }
}
