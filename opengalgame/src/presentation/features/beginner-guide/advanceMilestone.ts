import {
  GUIDE_STEP_ID,
  guideNextStep,
  guideStepById,
  type GuideMilestone,
  type GuideStep
} from './guideSteps'
import type { GuideAdvanceResult, GuideSessionState } from './advanceGuide'
import { initialGenerationCandidateProgress } from './advanceCandidate'
import { initialDialogueSaveProgress } from './advancePreview'
import { createActionPrompt } from './guidePrompt'

export function unchanged(state: GuideSessionState): GuideAdvanceResult {
  return { state, effects: [] }
}

/** 一拍最后一个里程碑完成时记录该拍；拍内其余动作不重复记录。 */
function markCompletedBeat(state: GuideSessionState, milestoneIndex: number): GuideSessionState {
  const step = guideStepById(state.stepId)
  const beatId = step.milestones[milestoneIndex]?.arrange?.beatId
  if (!beatId) return state
  const nextBeatId = step.milestones[milestoneIndex + 1]?.arrange?.beatId
  if (nextBeatId === beatId) return state
  if (state.completedBeats.includes(beatId)) return state
  return { ...state, completedBeats: [...state.completedBeats, beatId] }
}

/** 完成第 milestoneIndex 个里程碑；一次调用最多前进一步。 */
export function completeMilestone(
  state: GuideSessionState,
  milestoneIndex: number,
  options: { completion?: string } = {},
  forceAdvance = false
): GuideAdvanceResult {
  const step = guideStepById(state.stepId)
  const milestone = step.milestones[milestoneIndex]
  if (!milestone) return unchanged(state)
  const completion = options.completion ?? milestone.completion
  const base = markCompletedBeat(state, milestoneIndex)

  if (milestoneIndex < step.milestones.length - 1) {
    const nextIndex = milestoneIndex + 1
    const nextMilestone = step.milestones[nextIndex]
    return {
      state: {
        ...base,
        milestoneIndex: nextIndex,
        prompt: {
          stepId: step.id,
          stepNumber: step.number,
          milestoneId: nextMilestone.id,
          title: milestone.title,
          text: milestone.prompt,
          tone: 'waiting',
          hidden: state.collapsed,
          completion
        }
      },
      effects: []
    }
  }

  // 最后里程碑完成后，有些步骤要等用户自己确认（“编排好了”“已确认改动”），
  // 不按动作完成就替用户翻页；跳过或继续命令才真正进入下一步。
  if (step.confirmLabel && !forceAdvance) {
    return {
      state: {
        ...base,
        milestoneIndex: step.milestones.length,
        prompt: {
          stepId: step.id,
          stepNumber: step.number,
          milestoneId: milestone.id,
          title: milestone.title,
          text: milestone.prompt,
          tone: 'decision',
          hidden: state.collapsed,
          completion,
          confirmLabel: step.confirmLabel
        }
      },
      effects: []
    }
  }

  return advancePastStep(base, milestone, completion)
}

/** 最后里程碑已确认或整步已跳过：进入下一步；最后一步则完成教程。 */
export function advancePastStep(
  state: GuideSessionState,
  milestone: GuideMilestone,
  completion?: string
): GuideAdvanceResult {
  const step = guideStepById(state.stepId)
  const completedSteps = state.completedSteps.includes(step.id)
    ? state.completedSteps
    : [...state.completedSteps, step.id]
  const base: GuideSessionState = { ...state, completedSteps }
  const nextStep = guideNextStep(step.id)
  if (nextStep) {
    const carriedGenerationOperationId =
      step.id === GUIDE_STEP_ID.saveAndGenerate ? state.generationOperationId : null
    // 只有正常完成第 3 步「阅读文档」后才把选定的剧本卡带进第 4 步。
    // 目录跳步直接调用 enterStep，不传 scriptCardId，避免预绑只建过、没读的卡。
    const scriptCardId =
      step.id === GUIDE_STEP_ID.importScript && state.milestoneIndex >= step.milestones.length - 1
        ? state.documentCardId
        : null
    const entered = enterStep(
      { ...base, generationOperationId: carriedGenerationOperationId },
      nextStep,
      { scriptCardId }
    )
    return {
      state: {
        ...entered,
        generationOperationId: carriedGenerationOperationId,
        prompt: { ...entered.prompt, completion }
      },
      effects: [{ type: 'step-entered', stepId: nextStep.id }]
    }
  }

  return {
    state: {
      ...base,
      status: 'completed',
      prompt: {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: milestone.id,
        title: milestone.title,
        text: milestone.prompt,
        tone: 'done',
        hidden: state.collapsed,
        completion,
        finishLabel: step.finishLabel
      }
    },
    effects: [{ type: 'guide-completed' }]
  }
}

/** 进入一个步骤，清空上一步的对象绑定，避免旧卡片/旧候选误配。 */
export function enterStep(
  state: GuideSessionState,
  step: GuideStep,
  options: { scriptCardId?: string | null } = {}
): GuideSessionState {
  // 第 3 步正常读完并自动进入第 4 步时，调用方显式传入刚才阅读的剧本卡；
  // 目录跳步不传，用户需在画布上明确点选或亲手连出剧本端点，不从同类卡扫描。
  const scriptCardId = options.scriptCardId ?? null
  const arrangeCards =
    step.id === GUIDE_STEP_ID.arrangeScene && scriptCardId ? { script: scriptCardId } : {}
  return {
    ...state,
    stepId: step.id,
    milestoneIndex: 0,
    stepAttempt: state.stepAttempt + 1,
    status: 'following',
    prompt: createActionPrompt(step, state.collapsed),
    pauseReason: null,
    pendingScope: null,
    savedConfigFingerprint: null,
    createdProjectId: null,
    documentCardId: null,
    documentEditorCardId: null,
    arrangeCards,
    arrangeRelationId: null,
    arrangeRelationFromCardId: null,
    arrangeRelationToCardId: null,
    ...initialGenerationCandidateProgress(),
    ...initialDialogueSaveProgress()
  }
}
