import { GUIDE_STEP_ID, guideStepById } from './guideSteps'
import type { GuideAdvanceResult, GuideSessionState } from './advanceGuide'
import { advancePastStep, completeMilestone, unchanged } from './advanceMilestone'
import { candidateDecisionPrompt, candidateFlowOf } from './guidePrompt'

/** 第 6 步的候选状态机；只有 accepted 会进入下一步。 */
export type GuideCandidatePhase =
  | 'none'
  | 'ready'
  | 'opened'
  | 'returned'
  | 'revised'
  | 'regenerating'
  | 'discarded'

/** 第 5 步生成等待/失败的当前状态；只用于选择原位文案，不伪造进度。 */
export type GuideGenerationRunState = 'idle' | 'running' | 'failed'

export type GuideGenerationCandidateProgress = Pick<
  GuideSessionState,
  | 'generationOperationId'
  | 'generationRunState'
  | 'activeCandidateSnapshotId'
  | 'supersededCandidateSnapshotId'
  | 'candidatePhase'
  | 'candidateReplay'
>

/** 进入步骤或重置本步等待时，生成与候选相关字段的初始值。 */
export function initialGenerationCandidateProgress(): GuideGenerationCandidateProgress {
  return {
    generationOperationId: null,
    generationRunState: 'idle',
    activeCandidateSnapshotId: null,
    supersededCandidateSnapshotId: null,
    candidatePhase: 'none',
    candidateReplay: false
  }
}

export function applyCanvasSaved(
  state: GuideSessionState,
  reason: 'manual' | 'periodic' | 'beforeGeneration'
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.saveAndGenerate || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  if (reason !== 'manual') return unchanged(state)
  return completeMilestone(state, 0)
}

export function applyInputSummaryOpened(state: GuideSessionState): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.saveAndGenerate || state.milestoneIndex !== 1) {
    return unchanged(state)
  }
  return completeMilestone(state, 1)
}

export function applyGenerationStarted(
  state: GuideSessionState,
  operationId: string
): GuideAdvanceResult {
  if (state.stepId === GUIDE_STEP_ID.saveAndGenerate) {
    if (state.milestoneIndex !== 2) return unchanged(state)
    const step = guideStepById(state.stepId)
    const milestone = step.milestones[2]
    return {
      state: {
        ...state,
        generationOperationId: operationId,
        generationRunState: 'running',
        prompt: {
          stepId: step.id,
          stepNumber: step.number,
          milestoneId: milestone.id,
          title: milestone.title,
          text: milestone.prompt,
          tone: 'waiting',
          hidden: state.collapsed
        }
      },
      effects: []
    }
  }

  if (state.stepId === GUIDE_STEP_ID.playtestCandidate) {
    if (state.milestoneIndex !== 1) return unchanged(state)
    if (state.candidatePhase === 'none' || state.candidatePhase === 'opened') return unchanged(state)
    if (state.generationOperationId === operationId) return unchanged(state)
    const flow = candidateFlowOf(state)
    return {
      state: {
        ...state,
        generationOperationId: operationId,
        activeCandidateSnapshotId: null,
        supersededCandidateSnapshotId:
          state.activeCandidateSnapshotId ?? state.supersededCandidateSnapshotId,
        candidatePhase: 'regenerating',
        candidateReplay: false,
        prompt: candidateDecisionPrompt(
          state,
          flow.regeneratingPrompt,
          'waiting',
          flow.revisedTitle
        )
      },
      effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
    }
  }

  return unchanged(state)
}

export function applyGenerationFailed(
  state: GuideSessionState,
  operationId: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.saveAndGenerate || state.milestoneIndex !== 2) {
    return unchanged(state)
  }
  if (state.generationRunState !== 'running') return unchanged(state)
  if (!state.generationOperationId || state.generationOperationId !== operationId) {
    return unchanged(state)
  }
  const step = guideStepById(state.stepId)
  const failure = step.generationFailure
  if (!failure) return unchanged(state)
  return {
    state: {
      ...state,
      generationOperationId: null,
      generationRunState: 'failed',
      prompt: {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: 'generation-failed',
        title: failure.title,
        text: failure.prompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    },
    effects: []
  }
}

/** 当前生成操作未知时不拦已确认候选；已知时只收本次操作。 */
function operationMatches(state: GuideSessionState, operationId: string | undefined): boolean {
  if (state.generationOperationId === null) return true
  return operationId === undefined || operationId === state.generationOperationId
}

function isReplayCandidate(state: GuideSessionState): boolean {
  return (
    state.candidatePhase === 'revised' ||
    state.candidatePhase === 'regenerating' ||
    state.candidatePhase === 'discarded'
  )
}

/**
 * 第 5 步收到当前生成操作的候选：先进入第 6 步，再把这枚候选记为就绪。
 * 同一事实只在这里既结束等待又建立试玩状态，不要求页面重复上报。
 */
export function applyGenerationCandidateReady(
  state: GuideSessionState,
  candidateSnapshotId: string,
  operationId: string | undefined
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.saveAndGenerate) return unchanged(state)
  if (state.milestoneIndex !== 2 || state.generationRunState !== 'running') {
    return unchanged(state)
  }
  if (!state.generationOperationId) return unchanged(state)
  if (operationId !== undefined && operationId !== state.generationOperationId) {
    return unchanged(state)
  }

  const step = guideStepById(state.stepId)
  const advanced = advancePastStep(state, step.milestones[state.milestoneIndex])
  const ready = applyCandidateReady(advanced.state, candidateSnapshotId, operationId)
  return {
    state: ready.state,
    effects: [...advanced.effects, ...ready.effects]
  }
}

export function applyCandidateReady(
  state: GuideSessionState,
  candidateSnapshotId: string,
  operationId: string | undefined
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.playtestCandidate) return unchanged(state)
  if (state.candidatePhase === 'opened') return unchanged(state)
  if (candidateSnapshotId === state.supersededCandidateSnapshotId) return unchanged(state)
  if (candidateSnapshotId === state.activeCandidateSnapshotId) return unchanged(state)
  // 丢弃后必须由新的“开始生成”更新操作身份，旧任务迟到的候选不能复活。
  if (
    state.candidatePhase === 'discarded' &&
    state.generationOperationId !== null &&
    (operationId === undefined || operationId === state.generationOperationId)
  ) {
    return unchanged(state)
  }
  if (!operationMatches(state, operationId)) return unchanged(state)

  if (state.milestoneIndex === 0) {
    return completeMilestone(
      {
        ...state,
        generationOperationId: state.generationOperationId ?? operationId ?? null,
        activeCandidateSnapshotId: candidateSnapshotId,
        supersededCandidateSnapshotId: null,
        candidatePhase: 'ready',
        candidateReplay: false
      },
      0
    )
  }

  const step = guideStepById(state.stepId)
  const readyMilestone = step.milestones[0]
  const flow = candidateFlowOf(state)
  const replay = isReplayCandidate(state)
  return {
    state: {
      ...state,
      generationOperationId: state.generationOperationId ?? operationId ?? null,
      activeCandidateSnapshotId: candidateSnapshotId,
      candidatePhase: 'ready',
      candidateReplay: replay,
      prompt: {
        ...state.prompt,
        milestoneId: readyMilestone.id,
        title: replay ? flow.replayTitle : flow.readyTitle,
        text: readyMilestone.prompt,
        tone: 'waiting',
        hidden: state.collapsed,
        completion: undefined
      }
    },
    effects: []
  }
}

export function applyCandidateReturned(
  state: GuideSessionState,
  candidateSnapshotId: string | undefined
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.playtestCandidate) return unchanged(state)
  if (state.milestoneIndex !== 1) return unchanged(state)
  if (state.candidatePhase !== 'opened') return unchanged(state)
  if (
    candidateSnapshotId !== undefined &&
    state.activeCandidateSnapshotId !== null &&
    candidateSnapshotId !== state.activeCandidateSnapshotId
  ) {
    return unchanged(state)
  }
  if (state.activeCandidateSnapshotId === null) return unchanged(state)

  const flow = candidateFlowOf(state)
  return {
    state: {
      ...state,
      candidatePhase: 'returned',
      prompt: candidateDecisionPrompt(
        state,
        flow.returnedPrompt,
        'decision',
        flow.returnedTitle
      )
    },
    effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
  }
}

export function applyCandidateAccepted(
  state: GuideSessionState,
  candidateSnapshotId: string,
  operationId: string | undefined
): GuideAdvanceResult {
  // 正式提交可能先于试玩就绪通知到达：同一操作的确认提交直接补到第 6 步并结算。
  if (state.stepId === GUIDE_STEP_ID.saveAndGenerate) {
    if (state.milestoneIndex !== 2 || state.generationRunState !== 'running') {
      return unchanged(state)
    }
    if (!state.generationOperationId || operationId !== state.generationOperationId) {
      return unchanged(state)
    }
    const step = guideStepById(state.stepId)
    const advanced = advancePastStep(state, step.milestones[state.milestoneIndex])
    const ready = applyCandidateReady(advanced.state, candidateSnapshotId, operationId)
    const accepted = applyCandidateAccepted(ready.state, candidateSnapshotId, operationId)
    return {
      state: accepted.state,
      effects: [...advanced.effects, ...ready.effects, ...accepted.effects]
    }
  }

  if (state.stepId !== GUIDE_STEP_ID.playtestCandidate) return unchanged(state)
  if (state.milestoneIndex !== 1) return unchanged(state)
  if (!state.activeCandidateSnapshotId) return unchanged(state)
  if (candidateSnapshotId !== state.activeCandidateSnapshotId) return unchanged(state)
  if (candidateSnapshotId === state.supersededCandidateSnapshotId) return unchanged(state)
  if (state.generationOperationId !== null && operationId !== state.generationOperationId) {
    return unchanged(state)
  }

  return completeMilestone({ ...state, candidatePhase: 'none', candidateReplay: false }, 1)
}

export function applyCandidateFact(
  state: GuideSessionState,
  phase: 'opened' | 'revised' | 'discarded',
  candidateSnapshotId: string,
  operationId?: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.playtestCandidate) return unchanged(state)
  if (state.milestoneIndex !== 1) return unchanged(state)
  if (candidateSnapshotId === state.supersededCandidateSnapshotId) return unchanged(state)
  if (phase === 'revised' && !operationMatches(state, operationId)) return unchanged(state)

  const active = state.activeCandidateSnapshotId
  if (active === null) return unchanged(state)
  if (candidateSnapshotId !== active) return unchanged(state)

  const flow = candidateFlowOf(state)
  if (phase === 'opened') {
    return {
      state: {
        ...state,
        candidatePhase: 'opened',
        prompt: {
          ...state.prompt,
          milestoneId: 'candidate-accepted',
          title: flow.readyTitle,
          text: '正在试玩候选。读完返回工作台后，再决定接受、修改还是丢弃。',
          tone: 'waiting',
          hidden: state.collapsed
        }
      },
      effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
    }
  }

  if (phase === 'revised') {
    return {
      state: {
        ...state,
        activeCandidateSnapshotId: null,
        supersededCandidateSnapshotId: active ?? candidateSnapshotId,
        candidatePhase: 'revised',
        candidateReplay: false,
        prompt: candidateDecisionPrompt(
          state,
          flow.revisedPrompt,
          'waiting',
          flow.revisedTitle
        )
      },
      effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
    }
  }

  return {
    state: {
      ...state,
      activeCandidateSnapshotId: null,
      supersededCandidateSnapshotId: active ?? candidateSnapshotId,
      candidatePhase: 'discarded',
      candidateReplay: false,
      prompt: candidateDecisionPrompt(
        state,
        flow.discardedPrompt,
        'waiting',
        flow.discardedTitle
      )
    },
    effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
  }
}

export function applyCandidateCommand(
  state: GuideSessionState,
  phase: 'opened' | 'returned' | 'revised' | 'discarded',
  candidateSnapshotId?: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.playtestCandidate) return unchanged(state)
  if (state.status !== 'following') return unchanged(state)
  if (state.milestoneIndex !== 1) return unchanged(state)

  if (phase === 'opened') {
    if (!candidateSnapshotId) return unchanged(state)
    if (candidateSnapshotId === state.supersededCandidateSnapshotId) return unchanged(state)
    if (
      state.activeCandidateSnapshotId !== null &&
      candidateSnapshotId !== state.activeCandidateSnapshotId
    ) {
      return unchanged(state)
    }
    return {
      state: {
        ...state,
        activeCandidateSnapshotId: candidateSnapshotId,
        candidatePhase: 'opened',
        prompt: {
          ...state.prompt,
          milestoneId: 'candidate-accepted',
          title: candidateFlowOf(state).readyTitle,
          text: '正在试玩候选。读完返回工作台后，再决定接受、修改还是丢弃。',
          tone: 'waiting',
          hidden: state.collapsed
        }
      },
      effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
    }
  }

  if (phase === 'returned') {
    if (state.candidatePhase !== 'opened') return unchanged(state)
    if (
      candidateSnapshotId !== undefined &&
      state.activeCandidateSnapshotId !== null &&
      candidateSnapshotId !== state.activeCandidateSnapshotId
    ) {
      return unchanged(state)
    }
    const flow = candidateFlowOf(state)
    return {
      state: {
        ...state,
        candidatePhase: 'returned',
        prompt: candidateDecisionPrompt(
          state,
          flow.returnedPrompt,
          'decision',
          flow.returnedTitle
        )
      },
      effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
    }
  }

  if (state.candidatePhase !== 'opened' && state.candidatePhase !== 'returned') {
    return unchanged(state)
  }
  if (
    candidateSnapshotId !== undefined &&
    state.activeCandidateSnapshotId !== null &&
    candidateSnapshotId !== state.activeCandidateSnapshotId
  ) {
    return unchanged(state)
  }

  const flow = candidateFlowOf(state)
  const superseded = state.activeCandidateSnapshotId ?? candidateSnapshotId ?? null
  if (phase === 'revised') {
    return {
      state: {
        ...state,
        activeCandidateSnapshotId: null,
        supersededCandidateSnapshotId: superseded,
        candidatePhase: 'revised',
        candidateReplay: false,
        prompt: candidateDecisionPrompt(
          state,
          flow.revisedPrompt,
          'waiting',
          flow.revisedTitle
        )
      },
      effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
    }
  }

  return {
    state: {
      ...state,
      activeCandidateSnapshotId: null,
      supersededCandidateSnapshotId: superseded,
      candidatePhase: 'discarded',
      candidateReplay: false,
      prompt: candidateDecisionPrompt(
        state,
        flow.discardedPrompt,
        'waiting',
        flow.discardedTitle
      )
    },
    effects: state.collapsed ? [] : [{ type: 'overlay-shown' }]
  }
}
