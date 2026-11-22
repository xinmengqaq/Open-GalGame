import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationInteractionVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { isPiReviewCheckpointId } from '../workflow/piReviewCheckpoint'

/**
 * 第二阶段审阅边界曾只允许丢弃，并在提示里声明接受与修订未启用。
 * 这些记录属于同一产品的等待事实，恢复原有动作时只升级该边界，不改候选、回复或状态。
 */
const STAGE_HINTS = [
  '当前构建支持预览与丢弃；接受与修订将在后续阶段启用。',
  '当前构建仅支持预览与丢弃；修订将在后续阶段启用。'
]

export interface ReviewInteractionUpgrade {
  readonly execution: SceneGenerationExecution
  /** 记录实际被改写时为 true，供迁移决定是否写回。 */
  readonly changed: boolean
}

/**
 * 把第二阶段生成的审阅/修正等待恢复为原有动作集。
 * 只认 Pi 审阅边界上仅含丢弃的等待；其他交互、身份不一致或已有动作的记录保持原样。
 */
export function restorePhaseTwoReviewInteraction(
  execution: SceneGenerationExecution
): ReviewInteractionUpgrade {
  const interaction = execution.interaction
  if (
    interaction === undefined ||
    !isPiReviewCheckpointId(interaction.checkpointId) ||
    interaction.checkpointId !== execution.checkpointId ||
    (interaction.kind !== 'review' && interaction.kind !== 'correction') ||
    interaction.allowedReplies.length !== 1 ||
    interaction.allowedReplies[0] !== 'discard'
  )
    return { execution, changed: false }
  const restored = restoredInteraction(interaction)
  const seeded = seedPublishedCandidate({ ...execution, interaction: restored })
  const interactionChanged =
    restored.message !== interaction.message ||
    restored.allowedReplies.some((kind, index) => interaction.allowedReplies[index] !== kind) ||
    restored.allowedReplies.length !== interaction.allowedReplies.length
  return {
    execution: seeded.execution,
    changed: interactionChanged || seeded.changed
  }
}

/**
 * 旧等待记录没有候选修订列表；当前候选已经有通过结论时补记一条，供后续修改后按原检查点预览。
 * 有阻断问题的候选不登记。
 */
function seedPublishedCandidate(execution: SceneGenerationExecution): {
  execution: SceneGenerationExecution
  changed: boolean
} {
  const report = execution.artifactValidation
  if (
    execution.candidateSnapshotId === undefined ||
    execution.checkpointId === undefined ||
    report === undefined ||
    report.issues.length > 0 ||
    (execution.publishedCandidates ?? []).some(
      (record) => record.candidateSnapshotId === execution.candidateSnapshotId
    )
  )
    return { execution, changed: false }
  return {
    execution: {
      ...execution,
      publishedCandidates: [
        ...(execution.publishedCandidates ?? []),
        {
          candidateSnapshotId: execution.candidateSnapshotId,
          checkpointId: execution.checkpointId,
          artifactValidation: report
        }
      ]
    },
    changed: true
  }
}

/** 审阅等待恢复接受/修改/丢弃；修正等待只恢复修改/丢弃，不接受不完整候选。 */
function restoredInteraction(
  interaction: SceneGenerationInteractionVO
): SceneGenerationInteractionVO {
  const allowedReplies =
    interaction.kind === 'review'
      ? (['accept', 'revise', 'discard'] as const)
      : (['revise', 'discard'] as const)
  const message = withoutStageHint(interaction.message).trim()
  return {
    ...interaction,
    message: message === '' ? fallbackMessage(interaction.kind) : message,
    allowedReplies
  }
}

function withoutStageHint(message: string): string {
  return STAGE_HINTS.reduce((current, hint) => current.split(hint).join(''), message)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
}

function fallbackMessage(kind: SceneGenerationInteractionVO['kind']): string {
  return kind === 'review'
    ? '请审阅当前候选。'
    : '候选还不能进入预览，请说明要如何修正，或丢弃本次候选。'
}
