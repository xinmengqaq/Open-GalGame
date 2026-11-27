import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  emptyGuideScopeContext,
  guideFactKey,
  type GuideContextSnapshot,
  type GuideFact,
  type GuideObservationSource,
  type GuidePage,
  type GuideScopeContext
} from './guideObservation'
import {
  advanceGuide,
  restoreGuideSession,
  type GuideCommand,
  type GuidePrompt,
  type GuideSessionState
} from './advanceGuide'
import {
  factBelongsToPractice,
  guideScopeFromSnapshot,
  isMeaningfulScopeChange,
  resumeGuideScope
} from './guideScope'
import { GUIDE_FIRST_STEP_ID, GUIDE_STEP_ID, type GuideStepId } from './guideSteps'
import { guideBeatIdOf } from './guideNavigation'
import {
  readGuidePreferences,
  resolveGuideRestore,
  shouldAutoInvite,
  writeGuidePreferences,
  type GuidePreferenceStorage,
  type GuidePreferences,
  type GuideRestoreSignal
} from './guidePreferences'

export type GuideSessionMode = 'idle' | 'invited' | 'reading'

/** 目录/示例打开期间暂存的事实与到达顺序，关闭后按顺序应用。 */
export type DeferredGuideFact = {
  fact: GuideFact
}

const MAX_DEFERRED_GUIDE_FACTS = 64
const MAX_PAUSED_GUIDE_FACTS = 32

/** 暂停中不推进，只暂存生成/候选的权威结果；恢复同一工程后补齐，接受最后结算。 */
function shouldDeferPausedFact(fact: GuideFact): boolean {
  switch (fact.kind) {
    case 'generationStarted':
    case 'generationFailed':
    case 'candidateReady':
    case 'candidateAccepted':
    case 'candidateRevised':
    case 'candidateDiscarded':
      return true
    default:
      return false
  }
}

/** 只存在当前窗口的会话状态；偏好只保存是否处理邀请和上次步骤。 */
export type GuideSessionModel = {
  mode: GuideSessionMode
  preferences: GuidePreferences
  guide: GuideSessionState | null
  catalogOpen: boolean
  exampleOpen: boolean
  restoreSignal: GuideRestoreSignal | null
  /** 第 6 步「收起指引，去试玩」的临时隐藏，返回后自动展开。 */
  collapsedForTrial: boolean
  /** 回看目录/示例时不抢翻正在读的页，关闭后一次性应用。 */
  deferredFacts: readonly DeferredGuideFact[]
  /** 暂停期间到达的生成/候选终态；不在暂停中应用，恢复同工程后补齐。 */
  pausedFacts: readonly DeferredGuideFact[]
}

export type GuideSessionAction =
  | { type: 'show-invitation' }
  | { type: 'open-invitation' }
  | { type: 'dismiss-invitation' }
  | { type: 'start-tutorial'; stepId?: GuideStepId; scope?: GuideScopeContext }
  | { type: 'select-step'; stepId: GuideStepId; scope?: GuideScopeContext }
  | { type: 'restore-entry' }
  | { type: 'fact'; fact: GuideFact }
  | { type: 'sync-context'; scope: GuideScopeContext; page?: GuidePage }
  | { type: 'pause' }
  | { type: 'resume'; scope?: GuideScopeContext }
  | { type: 'collapse' }
  | { type: 'collapse-for-trial' }
  | { type: 'expand' }
  | { type: 'confirm-step' }
  | { type: 'skip-dialogue' }
  | { type: 'skip-model-config' }
  | { type: 'go-previous' }
  | { type: 'go-next' }
  | { type: 'open-catalog' }
  | { type: 'close-catalog' }
  | { type: 'open-example' }
  | { type: 'close-example' }
  | { type: 'hide-entry' }
  | { type: 'exit' }
  | { type: 'finish' }

/**
 * 初次进入时解析偏好。显式传入的初始值优先；否则按注入的 storage 读取。
 * storage 为 undefined 时走本机 localStorage，只有显式 null 才禁用存储。
 */
export function resolveInitialGuidePreferences(
  initialPreferences?: GuidePreferences,
  storage?: GuidePreferenceStorage | null
): GuidePreferences {
  return initialPreferences ?? readGuidePreferences(storage)
}

export function createGuideSessionModel(
  preferences: GuidePreferences = readGuidePreferences(),
  scope?: GuideScopeContext
): GuideSessionModel {
  const base: GuideSessionModel = {
    mode: 'idle',
    preferences,
    guide: null,
    catalogOpen: false,
    exampleOpen: false,
    restoreSignal: null,
    collapsedForTrial: false,
    deferredFacts: [],
    pausedFacts: []
  }
  // 退出后 tutorialModeActive 为 false，重启只显示入口，不弹邀请也不弹浮窗。
  if (!preferences.tutorialModeActive) return base

  const signal = resolveGuideRestore(preferences)
  if (signal.kind === 'open-catalog') {
    return {
      ...base,
      mode: 'reading',
      catalogOpen: true,
      restoreSignal: signal
    }
  }
  const stepId = signal.kind === 'resume' ? signal.stepId : GUIDE_FIRST_STEP_ID
  const beatId = signal.kind === 'resume' ? signal.beatId : null
  const restored = restoreGuideSession({
    stepId,
    beatId,
    scope: scope ?? emptyGuideScopeContext()
  })
  return { ...base, mode: 'reading', guide: restored.state }
}

/**
 * 纯会话归约：邀请、阅读、目录、示例和候选隐藏都只改本窗口状态。
 * 偏好写入通过注入的 storage 完成，不写 projectId。
 */
export function guideSessionReduce(
  model: GuideSessionModel,
  action: GuideSessionAction,
  storage?: GuidePreferenceStorage | null
): GuideSessionModel {
  switch (action.type) {
    case 'show-invitation':
      if (model.mode !== 'idle' || !shouldAutoInvite(model.preferences)) return model
      return { ...model, mode: 'invited', preferences: markHandled(model.preferences, storage) }

    case 'open-invitation': {
      // 独立入口在退出教程后仍可重新打开邀请；只有用户接受才重新进入阅读模式。
      if (model.mode !== 'idle') return model
      return { ...model, mode: 'invited', preferences: markHandled(model.preferences, storage) }
    }

    case 'dismiss-invitation': {
      if (model.mode !== 'invited') return model
      const preferences = setTutorialMode(markHandled(model.preferences, storage), false, storage)
      return { ...model, mode: 'idle', preferences }
    }

    case 'start-tutorial': {
      const preferences = markHandled(model.preferences, storage)
      const explicitStep = action.stepId
      if (explicitStep) {
        return startReading(model, preferences, explicitStep, action.scope, storage)
      }

      const signal = resolveGuideRestore(preferences)
      if (signal.kind === 'resume') {
        return startReading(model, preferences, signal.stepId, action.scope, storage, signal.beatId)
      }
      if (signal.kind === 'open-catalog') {
        return {
          ...model,
          mode: 'reading',
          preferences,
          guide: null,
          catalogOpen: true,
          exampleOpen: false,
          restoreSignal: signal,
          collapsedForTrial: false,
          deferredFacts: [],
          pausedFacts: []
        }
      }
      return startReading(model, preferences, GUIDE_FIRST_STEP_ID, action.scope, storage)
    }

    case 'select-step': {
      if (!model.guide) {
        return startReading(model, model.preferences, action.stepId, action.scope, storage)
      }
      // 目录跳步是显式选择：先把新上下文并入会话，再重置到该步开头，只显示
      // 「已跳到这一步」，不把任何等待中的动作记为成功。
      const contextual = action.scope
        ? advanceGuide(model.guide, { type: 'context-changed', scope: action.scope }).state
        : model.guide
      const selected = advanceGuide(contextual, {
        type: 'step-selected',
        stepId: action.stepId
      })
      const next = commitGuideResult(model, selected.state, storage, false)
      return {
        ...next,
        catalogOpen: false,
        exampleOpen: false,
        restoreSignal: null,
        collapsedForTrial: false,
        deferredFacts: [],
        pausedFacts: []
      }
    }

    case 'restore-entry': {
      if (!model.preferences.entryHidden) return model
      const preferences: GuidePreferences = { ...model.preferences, entryHidden: false }
      writeGuidePreferences(preferences, storage)
      return { ...model, preferences }
    }

    case 'fact': {
      if (!model.guide) return model
      // 事实不改变练习绑定；只有 sync-context 能暂停/切换上下文。
      // 暂停中只留住属于当前练习作用域的生成/候选结果，恢复后按顺序补齐。
      if (model.guide.status === 'paused') {
        if (
          !shouldDeferPausedFact(action.fact) ||
          !factBelongsToPractice(model.guide.scope, action.fact)
        ) {
          return model
        }
        const factKey = guideFactKey(action.fact)
        if (model.pausedFacts.some((entry) => guideFactKey(entry.fact) === factKey)) {
          return model
        }
        const pausedFacts = [...model.pausedFacts, { fact: action.fact }]
        return { ...model, pausedFacts: pausedFacts.slice(-MAX_PAUSED_GUIDE_FACTS) }
      }
      // 回看目录/示例时先暂存事实，避免后台事件把用户正在读的步骤和提示翻走；
      // 关闭弹窗后按到达顺序应用，重复与旧上下文仍由 reducer 过滤。
      if (model.catalogOpen || model.exampleOpen) {
        if (!factBelongsToPractice(model.guide.scope, action.fact)) return model
        const deferredFacts = [...model.deferredFacts, { fact: action.fact }]
        return { ...model, deferredFacts: deferredFacts.slice(-MAX_DEFERRED_GUIDE_FACTS) }
      }
      const result = advanceGuide(model.guide, { type: 'fact', fact: action.fact })
      return commitGuideResult(model, result.state, storage, true)
    }

    case 'sync-context': {
      if (!model.guide) return model
      const result = advanceGuide(model.guide, {
        type: 'context-changed',
        scope: action.scope
      })
      return commitGuideResult(model, result.state, storage, false)
    }

    case 'pause': {
      const next = applyGuideCommand(model, { type: 'pause' }, storage, false)
      return { ...next, pausedFacts: [] }
    }

    case 'resume': {
      const guide = model.guide
      if (!guide || guide.status !== 'paused') {
        const next = applyGuideCommand(
          model,
          { type: 'resume', scope: action.scope },
          storage,
          false
        )
        return { ...next, pausedFacts: [] }
      }
      const target = resumeGuideScope(guide.scope, guide.pendingScope, action.scope)
      const changed = isMeaningfulScopeChange(guide.scope, target)
      const next = applyGuideCommand(model, { type: 'resume', scope: target }, storage, false)
      return changed ? { ...next, pausedFacts: [] } : replayPausedFacts(next, storage)
    }

    case 'collapse':
      return applyGuideCommand(model, { type: 'collapse' }, storage, false)

    case 'collapse-for-trial': {
      const next = applyGuideCommand(model, { type: 'collapse' }, storage, false)
      if (!next.guide) return next
      return { ...next, collapsedForTrial: true }
    }

    case 'expand':
      return {
        ...applyGuideCommand(model, { type: 'expand' }, storage, false),
        collapsedForTrial: false
      }

    case 'confirm-step':
      return applyGuideCommand(model, { type: 'confirm-step' }, storage, false)

    case 'skip-dialogue':
      return applyGuideCommand(model, { type: 'skip' }, storage, true)

    case 'skip-model-config':
      return applyGuideCommand(model, { type: 'skip-model-config' }, storage, false)

    case 'go-previous':
      return applyGuideCommand(model, { type: 'go-previous' }, storage, false)

    case 'go-next':
      return applyGuideCommand(model, { type: 'go-next' }, storage, false)

    case 'open-catalog':
      return { ...model, catalogOpen: true, exampleOpen: false, deferredFacts: [] }

    case 'close-catalog':
      return closeCatalog(model, storage)

    case 'open-example':
      return { ...model, exampleOpen: true, catalogOpen: false, deferredFacts: [] }

    case 'close-example':
      return flushDeferredFacts({ ...model, exampleOpen: false }, storage)

    case 'hide-entry': {
      const preferences: GuidePreferences = {
        ...model.preferences,
        invitationHandled: true,
        tutorialModeActive: false,
        entryHidden: true
      }
      writeGuidePreferences(preferences, storage)
      return {
        ...model,
        mode: 'idle',
        preferences,
        guide: null,
        catalogOpen: false,
        exampleOpen: false,
        restoreSignal: null,
        collapsedForTrial: false,
        deferredFacts: [],
        pausedFacts: []
      }
    }

    case 'exit':
      return {
        ...model,
        mode: 'idle',
        preferences: setTutorialMode(model.preferences, false, storage),
        guide: null,
        catalogOpen: false,
        exampleOpen: false,
        collapsedForTrial: false,
        deferredFacts: [],
        pausedFacts: []
      }

    case 'finish': {
      if (!model.guide) return model
      const result = advanceGuide(model.guide, { type: 'finish' })
      if (result.state.status !== 'exited') return model
      return {
        ...model,
        mode: 'idle',
        preferences: setTutorialMode(model.preferences, false, storage),
        guide: null,
        catalogOpen: false,
        exampleOpen: false,
        collapsedForTrial: false,
        deferredFacts: [],
        pausedFacts: []
      }
    }

    default:
      return model
  }
}

function startReading(
  model: GuideSessionModel,
  preferences: GuidePreferences,
  stepId: GuideStepId,
  scope: GuideScopeContext | undefined,
  storage: GuidePreferenceStorage | null | undefined,
  beatId?: string | null
): GuideSessionModel {
  const restored = restoreGuideSession({
    stepId,
    beatId,
    scope: scope ?? model.guide?.scope ?? emptyGuideScopeContext()
  })
  const nextPreferences: GuidePreferences = {
    ...preferences,
    tutorialModeActive: true,
    lastStepId: restored.state.stepId,
    lastBeatId: guideBeatIdOf(restored.state),
    entryHidden: false
  }
  writeGuidePreferences(nextPreferences, storage)
  return {
    ...model,
    mode: 'reading',
    preferences: nextPreferences,
    guide: restored.state,
    catalogOpen: false,
    exampleOpen: false,
    restoreSignal: null,
    collapsedForTrial: false,
    deferredFacts: [],
    pausedFacts: []
  }
}

function applyGuideCommand(
  model: GuideSessionModel,
  command: GuideCommand,
  storage: GuidePreferenceStorage | null | undefined,
  autoRestore: boolean
): GuideSessionModel {
  if (!model.guide) return model
  const result = advanceGuide(model.guide, command)
  return commitGuideResult(model, result.state, storage, autoRestore)
}

function commitGuideResult(
  model: GuideSessionModel,
  guide: GuideSessionState,
  storage: GuidePreferenceStorage | null | undefined,
  autoRestore: boolean
): GuideSessionModel {
  const previousStepId = model.guide?.stepId
  const previousBeatId = model.guide ? guideBeatIdOf(model.guide) : null
  const nextBeatId = guideBeatIdOf(guide)
  let preferences = model.preferences
  if (guide.stepId !== previousStepId || nextBeatId !== previousBeatId) {
    preferences = {
      ...model.preferences,
      lastStepId: guide.stepId,
      lastBeatId: nextBeatId
    }
    writeGuidePreferences(preferences, storage)
  }

  if (guide.status === 'exited') {
    return {
      ...model,
      mode: 'idle',
      guide: null,
      preferences: setTutorialMode(preferences, false, storage),
      collapsedForTrial: false
    }
  }

  let nextGuide = guide
  let collapsedForTrial = model.collapsedForTrial
  if (autoRestore && collapsedForTrial && shouldRestoreAfterTrial(guide)) {
    nextGuide = advanceGuide(guide, { type: 'expand' }).state
    collapsedForTrial = false
  }

  return { ...model, guide: nextGuide, preferences, collapsedForTrial }
}

function shouldRestoreAfterTrial(guide: GuideSessionState): boolean {
  if (guide.stepId !== GUIDE_STEP_ID.playtestCandidate) return true
  return (
    guide.candidatePhase === 'returned' ||
    guide.candidatePhase === 'revised' ||
    guide.candidatePhase === 'regenerating' ||
    guide.candidatePhase === 'discarded'
  )
}

/** 关闭回看层后应用暂存事实，让浮层回到当前提示。 */
function flushDeferredFacts(
  model: GuideSessionModel,
  storage: GuidePreferenceStorage | null | undefined
): GuideSessionModel {
  if (model.deferredFacts.length === 0) return model
  const deferredFacts = model.deferredFacts
  const base: GuideSessionModel = { ...model, deferredFacts: [] }
  if (!base.guide) return base

  let guide = base.guide
  for (const deferred of deferredFacts) {
    if (!factBelongsToPractice(guide.scope, deferred.fact)) continue
    guide = advanceGuide(guide, { type: 'fact', fact: deferred.fact }).state
  }
  return commitGuideResult(base, guide, storage, true)
}

/** 恢复同一工程后补齐暂停期间留住的生成/候选终态；旧上下文仍由 reducer 过滤。 */
function replayPausedFacts(
  model: GuideSessionModel,
  storage: GuidePreferenceStorage | null | undefined
): GuideSessionModel {
  const pausedFacts = model.pausedFacts
  const base: GuideSessionModel = { ...model, pausedFacts: [] }
  if (!base.guide || pausedFacts.length === 0) return base

  // 先补齐启动/就绪/失败等当前操作事实，再结算接受：如果暂停期间已经换了
  // 新操作，旧操作的迟到接受不能把教程带过新练习。
  const lifecycle = pausedFacts.filter((paused) => paused.fact.kind !== 'candidateAccepted')
  const accepted = pausedFacts.filter((paused) => paused.fact.kind === 'candidateAccepted')

  let guide = base.guide
  for (const paused of [...lifecycle, ...accepted]) {
    if (!factBelongsToPractice(guide.scope, paused.fact)) continue
    guide = advanceGuide(guide, { type: 'fact', fact: paused.fact }).state
  }
  return commitGuideResult(base, guide, storage, true)
}

function closeCatalog(
  model: GuideSessionModel,
  storage: GuidePreferenceStorage | null | undefined
): GuideSessionModel {
  const flushed = flushDeferredFacts(model, storage)
  const next = { ...flushed, catalogOpen: false }
  if (next.mode === 'reading' && !next.guide) {
    return {
      ...next,
      mode: 'idle',
      preferences: setTutorialMode(next.preferences, false, storage),
      deferredFacts: []
    }
  }
  return next
}

function markHandled(
  preferences: GuidePreferences,
  storage: GuidePreferenceStorage | null | undefined
): GuidePreferences {
  if (preferences.invitationHandled) return preferences
  const next: GuidePreferences = { ...preferences, invitationHandled: true }
  writeGuidePreferences(next, storage)
  return next
}

/** 教程模式的显式开关；只有开始/继续阅读和退出/结束阅读会改变它。 */
function setTutorialMode(
  preferences: GuidePreferences,
  active: boolean,
  storage: GuidePreferenceStorage | null | undefined
): GuidePreferences {
  if (preferences.tutorialModeActive === active) return preferences
  const next: GuidePreferences = { ...preferences, tutorialModeActive: active }
  writeGuidePreferences(next, storage)
  return next
}

export type UseGuideSessionOptions = {
  source: GuideObservationSource
  storage?: GuidePreferenceStorage | null
  initialPreferences?: GuidePreferences
}

export type GuideSessionView = {
  mode: GuideSessionMode
  invitationOpen: boolean
  reading: boolean
  catalogOpen: boolean
  exampleOpen: boolean
  guide: GuideSessionState | null
  prompt: GuidePrompt | null
  shouldAutoInvite: boolean
  lastStepId: string | null
  entryHidden: boolean
}

export type GuideSessionActions = {
  showInvitation: () => void
  openInvitation: () => void
  dismissInvitation: () => void
  startTutorial: (stepId?: GuideStepId) => void
  selectStep: (stepId: GuideStepId) => void
  restoreEntry: () => void
  pause: () => void
  resume: () => void
  collapse: () => void
  collapseForTrial: () => void
  expand: () => void
  confirmStep: () => void
  skipDialogue: () => void
  skipModelConfig: () => void
  previous: () => void
  next: () => void
  openCatalog: () => void
  closeCatalog: () => void
  openExample: () => void
  closeExample: () => void
  hideEntry: () => void
  exit: () => void
  finish: () => void
  syncContext: (snapshot: GuideContextSnapshot) => void
}

/**
 * 窗口内会话 hook。只在阅读模式下向 source 订阅；退出或卸载时解除订阅。
 * 不碰 DOM、不直接监听页面事件，页面上下文由 Host 通过 syncContext 传入。
 */
export function useGuideSession(options: UseGuideSessionOptions): {
  session: GuideSessionView
  actions: GuideSessionActions
} {
  const { source, storage } = options
  const [model, setModel] = useState<GuideSessionModel>(() => {
    const preferences = resolveInitialGuidePreferences(options.initialPreferences, storage)
    let scope: GuideScopeContext | undefined
    try {
      scope = guideScopeFromSnapshot(source.readCurrent())
    } catch {
      scope = undefined
    }
    return createGuideSessionModel(preferences, scope)
  })

  const storageRef = useRef(storage)
  useEffect(() => {
    storageRef.current = storage
  }, [storage])

  const dispatch = useCallback((action: GuideSessionAction) => {
    setModel((current) => guideSessionReduce(current, action, storageRef.current))
  }, [])

  const handleFact = useCallback(
    (fact: GuideFact) => {
      dispatch({ type: 'fact', fact })
    },
    [dispatch]
  )

  const isReading = model.mode === 'reading' && model.guide !== null
  useEffect(() => {
    if (!isReading) return
    const unsubscribe = source.subscribe(handleFact)
    return unsubscribe
  }, [handleFact, isReading, source])

  const session = useMemo<GuideSessionView>(
    () => ({
      mode: model.mode,
      invitationOpen: model.mode === 'invited',
      reading: model.mode === 'reading',
      catalogOpen: model.catalogOpen,
      exampleOpen: model.exampleOpen,
      guide: model.guide,
      prompt: model.guide?.prompt ?? null,
      shouldAutoInvite: model.mode === 'idle' && shouldAutoInvite(model.preferences),
      lastStepId: model.preferences.lastStepId,
      entryHidden: model.preferences.entryHidden
    }),
    [model]
  )

  const actions = useMemo<GuideSessionActions>(() => {
    const withScope = (): GuideScopeContext | undefined => {
      try {
        return guideScopeFromSnapshot(source.readCurrent())
      } catch {
        return undefined
      }
    }

    return {
      showInvitation: () => dispatch({ type: 'show-invitation' }),
      openInvitation: () => dispatch({ type: 'open-invitation' }),
      dismissInvitation: () => dispatch({ type: 'dismiss-invitation' }),
      startTutorial: (stepId) => dispatch({ type: 'start-tutorial', stepId, scope: withScope() }),
      selectStep: (stepId) => dispatch({ type: 'select-step', stepId, scope: withScope() }),
      restoreEntry: () => dispatch({ type: 'restore-entry' }),
      pause: () => dispatch({ type: 'pause' }),
      resume: () => dispatch({ type: 'resume', scope: withScope() }),
      collapse: () => dispatch({ type: 'collapse' }),
      collapseForTrial: () => dispatch({ type: 'collapse-for-trial' }),
      expand: () => dispatch({ type: 'expand' }),
      confirmStep: () => dispatch({ type: 'confirm-step' }),
      skipDialogue: () => dispatch({ type: 'skip-dialogue' }),
      skipModelConfig: () => dispatch({ type: 'skip-model-config' }),
      previous: () => dispatch({ type: 'go-previous' }),
      next: () => dispatch({ type: 'go-next' }),
      openCatalog: () => dispatch({ type: 'open-catalog' }),
      closeCatalog: () => dispatch({ type: 'close-catalog' }),
      openExample: () => dispatch({ type: 'open-example' }),
      closeExample: () => dispatch({ type: 'close-example' }),
      hideEntry: () => dispatch({ type: 'hide-entry' }),
      exit: () => dispatch({ type: 'exit' }),
      finish: () => dispatch({ type: 'finish' }),
      syncContext: (snapshot) =>
        dispatch({
          type: 'sync-context',
          scope: guideScopeFromSnapshot(snapshot),
          page: snapshot.page
        })
    }
  }, [dispatch, source])

  return { session, actions }
}
