import { randomUUID } from 'node:crypto'
import type {
  SceneGenerationInteractionVO,
  SceneGenerationQuestionVO
} from '@application/scene-generation/vo/SceneGenerationVO'
import { safeSceneValidationIssueMessage } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import type { WebGalSceneAgentOutput } from '../../agents/WebGalSceneAgentTypes'
import type { WebGalGenerationStateValue } from '../WebGalGenerationState'

/** 修正提示只用固定说明，不转发校验原文、路径或模型输出。 */
function correctionMessage(state: WebGalGenerationStateValue): string {
  const lines = (state.execution.artifactValidation?.issues ?? []).flatMap((issue) => {
    const message = safeSceneValidationIssueMessage(issue.code)
    return message ? [message] : []
  })
  const correctionsUsed =
    (state.execution.budget.correctionsUsed as number | undefined) ??
    state.execution.policy.maxCorrections
  const progress = correctionsUsed > 0 ? `已自动修正 ${correctionsUsed} 次。` : ''
  if (lines.length === 0) return `${progress}已确认要求与单场景规则冲突，请修改要求或候选后继续`
  return `${progress}候选还不能进入预览。${lines.join('；')}。请说明要如何修正。`
}

/**
 * 同轮有题时先问创作决定，避免澄清或修正挡住尚未展示的题组。
 * 已有候选后题组不再是决定边界，只能按修正继续。
 * 模型显式报告的阻塞优先于旧未解决问题，不能被投影成澄清。
 */
export function waitingKind(
  state: WebGalGenerationStateValue
): 'decision' | 'clarification' | 'correction' | 'review' {
  if (!state.execution.candidateSnapshotId && (state.questions ?? []).length > 0) return 'decision'
  if (state.blockedReason && state.blockedReason.trim().length > 0) return 'correction'
  if (state.unresolvedIssues?.length) return 'clarification'
  if (state.needsDecision) return 'correction'
  return 'review'
}

/** 只认领域按题目构造的选择事实，不看请求数组下标。 */
export function selectionsCover(
  questions: readonly { questionId: string }[],
  selections: readonly { questionId: string }[] | undefined
): boolean {
  if (!selections || selections.length !== questions.length) return false
  const ids = new Set(selections.map((item) => item.questionId))
  if (ids.size !== selections.length) return false
  return questions.every((question) => ids.has(question.questionId))
}

/** 为一次持久等待分配新身份，旧候选回复不会命中新的等待。 */
export function generationInteraction(
  state: WebGalGenerationStateValue,
  checkpointId: string
): SceneGenerationInteractionVO {
  const kind = waitingKind(state)
  const candidateSnapshotId = state.execution.candidateSnapshotId
  if (kind === 'clarification')
    return {
      interactionId: randomUUID(),
      checkpointId,
      kind,
      message: (state.unresolvedIssues ?? []).join('\n'),
      options: [
        { id: 'reviewCandidate', label: '说明不阻断审阅' },
        { id: 'revise', label: '根据说明修改候选' }
      ],
      allowedReplies: ['clarify', 'revise', 'select', 'discard'],
      candidateSnapshotId
    }
  if (kind === 'correction')
    return {
      interactionId: randomUUID(),
      checkpointId,
      kind,
      message:
        state.blockedReason && state.blockedReason.trim().length > 0
          ? state.blockedReason
          : correctionMessage(state),
      options: [],
      allowedReplies: ['revise', 'discard'],
      candidateSnapshotId
    }
  if (kind === 'decision')
    return {
      interactionId: randomUUID(),
      checkpointId,
      kind,
      message: '本轮需要你先确认创作决定，确认后会继续生成。',
      options: [],
      questions: state.questions,
      allowedReplies: ['answers', 'discard'],
      candidateSnapshotId
    }
  const reviewNotice = state.summaryDegraded === true ? '完成摘要未生成，请核对创作取舍' : undefined
  const report = (state.execution.artifactValidation?.issues ?? []).flatMap((issue) => {
    const message = safeSceneValidationIssueMessage(issue.code)
    return message ? [message] : []
  })
  return {
    interactionId: randomUUID(),
    checkpointId,
    kind: 'review',
    message: ['请审阅当前候选', reviewNotice, ...report].filter(Boolean).join('\n'),
    options: [],
    allowedReplies: ['accept', 'revise', 'discard'],
    candidateSnapshotId
  }
}

/** 模型只提供文案。题号和选项号由本次写入生成，不采用模型身份。 */
export function assignedQuestions(
  questions: WebGalSceneAgentOutput['questions'] | undefined
): readonly SceneGenerationQuestionVO[] {
  return (questions ?? []).map((question, questionIndex) => ({
    questionId: `q${questionIndex + 1}`,
    prompt: question.prompt.trim(),
    ...(question.detail?.trim() ? { detail: question.detail.trim() } : {}),
    options: question.options.map((option, optionIndex) => ({
      id: `q${questionIndex + 1}o${optionIndex + 1}`,
      label: option.label.trim(),
      description: option.description.trim()
    }))
  }))
}
