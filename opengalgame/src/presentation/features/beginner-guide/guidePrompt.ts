import {
  GUIDE_DOCUMENT_EDITOR_PROMPT,
  GUIDE_STEP_ID,
  guideStepById,
  type GuideCandidateFlow,
  type GuideStep
} from './guideSteps'
import type { GuidePrompt, GuidePromptTone, GuideSessionState } from './advanceGuide'

export function createActionPrompt(step: GuideStep, collapsed: boolean): GuidePrompt {
  return {
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: step.milestones[0]?.id ?? null,
    title: step.actionTitle,
    text: step.action,
    tone: 'action',
    hidden: collapsed
  }
}

/**
 * 预览页里当前真正能做的动作和页面外不同：
 * 第 7 步已进入预览，不再提示「打开预览」；第 8 步要先点实际返回控件。
 * 只在预览打开时由 Host 采用，不写回会话状态。
 */
export function previewGuidePrompt(state: GuideSessionState): GuidePrompt | null {
  if (state.status !== 'following' || state.prompt.tone !== 'action') return null
  if (state.stepId === GUIDE_STEP_ID.polishDialogue && state.milestoneIndex === 0) {
    if (state.dialogueDraftDirty || state.dialogueSaveUnresolved) return null
    return {
      stepId: state.stepId,
      stepNumber: guideStepById(state.stepId).number,
      milestoneId: 'dialogue-preview-edit',
      title: '选一句，改成新台词',
      text: '在左侧点一句对白，按铅笔或回车修改；改完点顶部「保存」，这句会写回当前场景。只读时先返回工作台处理。',
      tone: 'action',
      hidden: state.collapsed
    }
  }
  if (state.stepId === GUIDE_STEP_ID.exportBuild && state.milestoneIndex === 0) {
    return {
      stepId: state.stepId,
      stepNumber: guideStepById(state.stepId).number,
      milestoneId: 'export-return-preview',
      title: '先回到工作台',
      text: '点左上角「返回工作台」，再打开「导出」并开始。',
      tone: 'action',
      hidden: state.collapsed
    }
  }
  return null
}

/** 第 7 步真实未保存改词：只提示去预览保存，不携带对白。 */
export function dialogueDraftPromptFor(state: GuideSessionState): GuidePrompt | null {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) return null
  const step = guideStepById(state.stepId)
  const copy = step.dialogueDraftPrompt
  if (!copy) return null
  return {
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: 'dialogue-draft',
    title: copy.title,
    text: copy.prompt,
    tone: 'waiting',
    hidden: state.collapsed
  }
}

/** 第 7 步保存失败或待核对：原位提示先处理，不显示跳过。 */
export function dialogueSaveFailurePromptFor(state: GuideSessionState): GuidePrompt | null {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) return null
  const step = guideStepById(state.stepId)
  const copy = step.dialogueSaveFailure
  if (!copy) return null
  return {
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: 'dialogue-save-failed',
    title: copy.title,
    text: copy.prompt,
    tone: 'waiting',
    hidden: state.collapsed
  }
}

/** 第 7 步只有未处理失败时隐藏跳过；无改动结算或放弃后恢复。 */
export function canSkipGuideStep(
  state: GuideSessionState,
  prompt: GuidePrompt,
  completed: boolean
): boolean {
  const step = guideStepById(state.stepId)
  return step.skippable && !completed && !prompt.confirmLabel && !state.dialogueSaveUnresolved
}

/** 恢复跟随或切换上下文后，按当前进度重建提示。 */
export function promptForProgress(state: GuideSessionState): GuidePrompt {
  const step = guideStepById(state.stepId)
  if (state.status === 'completed') {
    const milestone = step.milestones[step.milestones.length - 1]
    return {
      stepId: step.id,
      stepNumber: step.number,
      milestoneId: milestone.id,
      title: milestone.title,
      text: milestone.prompt,
      tone: 'done',
      hidden: state.collapsed,
      finishLabel: step.finishLabel
    }
  }

  // 第 3 步停在文档编辑器期间，恢复跟随仍显示可查看/编辑，而不是退回“打开编辑器”。
  if (step.id === GUIDE_STEP_ID.importScript && state.documentEditorCardId) {
    return {
      stepId: step.id,
      stepNumber: step.number,
      milestoneId: 'document-read',
      title: GUIDE_DOCUMENT_EDITOR_PROMPT.title,
      text: GUIDE_DOCUMENT_EDITOR_PROMPT.prompt,
      tone: 'waiting',
      hidden: state.collapsed
    }
  }

  if (step.id === GUIDE_STEP_ID.playtestCandidate && state.candidatePhase !== 'none') {
    return candidatePrompt(state)
  }

  // 第 5 步开始生成后保持原位等待；失败后等用户重试，不按“开始请求”翻步。
  if (step.id === GUIDE_STEP_ID.saveAndGenerate && state.milestoneIndex === 2) {
    if (state.generationRunState === 'failed' && step.generationFailure) {
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: 'generation-failed',
        title: step.generationFailure.title,
        text: step.generationFailure.prompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    }
    if (state.generationRunState === 'running') {
      const milestone = step.milestones[2]
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: milestone.id,
        title: milestone.title,
        text: milestone.prompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    }
  }

  // 第 7 步的失败和未保存改词只改原位文案，不靠步骤进度猜。
  if (step.id === GUIDE_STEP_ID.polishDialogue && state.milestoneIndex === 0) {
    if (state.dialogueSaveUnresolved) {
      const failure = dialogueSaveFailurePromptFor(state)
      if (failure) return failure
    }
    if (state.dialogueDraftDirty) {
      const draft = dialogueDraftPromptFor(state)
      if (draft) return draft
    }
  }

  if (step.confirmLabel && state.milestoneIndex >= step.milestones.length) {
    const milestone = step.milestones[step.milestones.length - 1]
    return {
      stepId: step.id,
      stepNumber: step.number,
      milestoneId: milestone.id,
      title: milestone.title,
      text: milestone.prompt,
      tone: 'decision',
      hidden: state.collapsed,
      confirmLabel: step.confirmLabel
    }
  }

  if (state.milestoneIndex === 0) return createActionPrompt(step, state.collapsed)

  const waitingMilestone = step.milestones[state.milestoneIndex]
  const completedMilestone = step.milestones[state.milestoneIndex - 1]
  return {
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: waitingMilestone.id,
    title: completedMilestone.title,
    text: completedMilestone.prompt,
    tone: 'waiting',
    hidden: state.collapsed,
    completion: completedMilestone.completion
  }
}

function candidatePrompt(state: GuideSessionState): GuidePrompt {
  const step = guideStepById(state.stepId)
  const flow = candidateFlowOf(state)
  const acceptedMilestone = step.milestones[1]
  const readyMilestone = step.milestones[0]
  switch (state.candidatePhase) {
    case 'opened':
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: acceptedMilestone.id,
        title: flow.readyTitle,
        text: '正在试玩候选。读完返回工作台后，再决定接受、修改还是丢弃。',
        tone: 'waiting',
        hidden: state.collapsed
      }
    case 'returned':
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: acceptedMilestone.id,
        title: flow.returnedTitle,
        text: flow.returnedPrompt,
        tone: 'decision',
        hidden: state.collapsed
      }
    case 'revised':
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: acceptedMilestone.id,
        title: flow.revisedTitle,
        text: flow.revisedPrompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    case 'regenerating':
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: acceptedMilestone.id,
        title: flow.revisedTitle,
        text: flow.regeneratingPrompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    case 'discarded':
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: acceptedMilestone.id,
        title: flow.discardedTitle,
        text: flow.discardedPrompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    default:
      return {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: readyMilestone.id,
        title: state.candidateReplay ? flow.replayTitle : flow.readyTitle,
        text: readyMilestone.prompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
  }
}

export function candidateDecisionPrompt(
  state: GuideSessionState,
  text: string,
  tone: GuidePromptTone,
  title: string
): GuidePrompt {
  const step = guideStepById(state.stepId)
  return {
    ...state.prompt,
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: 'candidate-accepted',
    title,
    text,
    tone,
    hidden: state.collapsed,
    completion: undefined
  }
}

export function candidateFlowOf(state: GuideSessionState): GuideCandidateFlow {
  const step = guideStepById(state.stepId)
  if (!step.candidateFlow) {
    throw new Error(`步骤 ${step.id} 没有候选流程文案`)
  }
  return step.candidateFlow
}
