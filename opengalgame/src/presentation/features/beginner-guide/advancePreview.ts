import { GUIDE_STEP_ID, guideStepById } from './guideSteps'
import type { GuideAdvanceResult, GuideSessionState } from './advanceGuide'
import { completeMilestone, unchanged } from './advanceMilestone'
import {
  createActionPrompt,
  dialogueDraftPromptFor,
  dialogueSaveFailurePromptFor
} from './guidePrompt'

/** 第 7 步的保存状态；只记录当前预览保存请求，不保存对白内容。 */
export type GuideDialogueSaveProgress = Pick<
  GuideSessionState,
  | 'dialogueDraftDirty'
  | 'dialogueSaveRequestId'
  | 'dialogueSaveResolved'
  | 'dialogueSaveUnresolved'
>

/** 进入步骤或重置本步等待时，第 7 步保存相关字段的初始值。 */
export function initialDialogueSaveProgress(): GuideDialogueSaveProgress {
  return {
    dialogueDraftDirty: false,
    dialogueSaveRequestId: null,
    dialogueSaveResolved: false,
    dialogueSaveUnresolved: false
  }
}

export function applyDialogueSaveStarted(
  state: GuideSessionState,
  requestId: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  const next: GuideSessionState = {
    ...state,
    dialogueSaveRequestId: requestId,
    dialogueSaveResolved: false,
    dialogueSaveUnresolved: false
  }
  return {
    state: {
      ...next,
      prompt:
        dialogueDraftPromptFor(next) ?? createActionPrompt(guideStepById(state.stepId), state.collapsed)
    },
    effects: []
  }
}

export function applyDialogueSaved(
  state: GuideSessionState,
  requestId?: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  if (requestId !== undefined && state.dialogueSaveRequestId !== null) {
    if (state.dialogueSaveResolved || requestId !== state.dialogueSaveRequestId) {
      return unchanged(state)
    }
  }
  return completeMilestone(
    {
      ...state,
      dialogueSaveRequestId: requestId ?? state.dialogueSaveRequestId,
      dialogueSaveResolved: true,
      dialogueSaveUnresolved: false
    },
    0
  )
}

/** 保存失败或待核对：原位提示先处理，不显示成已保存。 */
export function applyDialogueSaveUnsettled(
  state: GuideSessionState,
  requestId?: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  if (requestId !== undefined && state.dialogueSaveRequestId !== null) {
    if (state.dialogueSaveResolved || requestId !== state.dialogueSaveRequestId) {
      return unchanged(state)
    }
  }
  const next: GuideSessionState = {
    ...state,
    dialogueSaveRequestId: requestId ?? state.dialogueSaveRequestId,
    dialogueSaveResolved: false,
    dialogueSaveUnresolved: true
  }
  const failure = dialogueSaveFailurePromptFor(next)
  if (!failure) return unchanged(state)
  return { state: { ...next, prompt: failure }, effects: [] }
}

/** 真实未保存改词只改窄提示；失败未处理时保留失败文案。 */
export function applyDialogueDraftChanged(
  state: GuideSessionState,
  dirty: boolean
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  if (state.dialogueDraftDirty === dirty) return unchanged(state)
  const next: GuideSessionState = { ...state, dialogueDraftDirty: dirty }
  if (state.dialogueSaveUnresolved) return { state: next, effects: [] }
  const step = guideStepById(state.stepId)
  return {
    state: {
      ...next,
      prompt: dirty
        ? (dialogueDraftPromptFor(next) ?? createActionPrompt(step, state.collapsed))
        : createActionPrompt(step, state.collapsed)
    },
    effects: []
  }
}

/** 无改动结算或明确放弃：恢复本步初始选择和跳过；不合成保存成功。 */
export function applyDialogueSaveCleared(
  state: GuideSessionState,
  requestId: string | undefined,
  clearReason: 'unchanged' | 'abandoned'
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.polishDialogue || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  if (requestId !== undefined && state.dialogueSaveRequestId !== null) {
    if (requestId !== state.dialogueSaveRequestId) return unchanged(state)
    if (state.dialogueSaveResolved) return unchanged(state)
  }
  const step = guideStepById(state.stepId)
  const next: GuideSessionState = {
    ...state,
    dialogueDraftDirty: clearReason === 'abandoned' ? false : state.dialogueDraftDirty,
    dialogueSaveRequestId: requestId ?? state.dialogueSaveRequestId,
    dialogueSaveResolved: true,
    dialogueSaveUnresolved: false
  }
  return {
    state: {
      ...next,
      prompt:
        next.dialogueDraftDirty
          ? (dialogueDraftPromptFor(next) ?? createActionPrompt(step, state.collapsed))
          : createActionPrompt(step, state.collapsed)
    },
    effects: []
  }
}
