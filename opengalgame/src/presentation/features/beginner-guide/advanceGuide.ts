import {
  emptyGuideScopeContext,
  guideFactKey,
  isGuideCardKindOf,
  type GuideCardKind,
  type GuideFact,
  type GuideScopeContext,
  type RelationCreatedFact,
  type RelationDeletedFact,
  type RelationNamedFact
} from './guideObservation'
import {
  GUIDE_ARRANGE_BEATS,
  GUIDE_ARRANGE_CARD_KIND,
  GUIDE_DOCUMENT_EDITOR_PROMPT,
  GUIDE_FIRST_STEP_ID,
  GUIDE_STEP_ID,
  guideArrangeBeatById,
  guideArrangeCardKindLabel,
  guideStepById,
  isGuideArrangeBeatId,
  isGuideStepId,
  type GuideArrangeBeatId,
  type GuideArrangeCardRole,
  type GuideArrangeStage,
  type GuideMilestone,
  type GuideStepId
} from './guideSteps'
import {
  applyCanvasSaved,
  applyCandidateAccepted,
  applyCandidateCommand,
  applyCandidateFact,
  applyCandidateReady,
  applyCandidateReturned,
  applyGenerationCandidateReady,
  applyGenerationFailed,
  applyGenerationStarted,
  applyInputSummaryOpened,
  initialGenerationCandidateProgress,
  type GuideCandidatePhase,
  type GuideGenerationRunState
} from './advanceCandidate'
import { advancePastStep, completeMilestone, enterStep, unchanged } from './advanceMilestone'
import {
  applyDialogueDraftChanged,
  applyDialogueSaveCleared,
  applyDialogueSaveStarted,
  applyDialogueSaveUnsettled,
  applyDialogueSaved,
  initialDialogueSaveProgress
} from './advancePreview'
import { createActionPrompt, promptForProgress } from './guidePrompt'
import {
  guideNavUnitMilestoneIndex,
  guideNavUnitPrompt,
  guideNextNavUnit,
  guidePreviousNavUnit,
  type GuideNavTarget,
  type GuideNavUnit
} from './guideNavigation'
import {
  copyScope,
  factBelongsToPractice,
  factEstablishesScope,
  isMeaningfulScopeChange,
  mergeScope,
  resumeGuideScope
} from './guideScope'

export type GuideSessionStatus = 'following' | 'paused' | 'completed' | 'exited'

export type GuidePauseReason = 'scope-changed'

export type GuidePromptTone = 'action' | 'waiting' | 'decision' | 'done' | 'paused'

/** 第 4 步的角色绑定；同一张卡不得占用两个角色。 */
export type GuideArrangeBindings = Readonly<Partial<Record<GuideArrangeCardRole, string>>>

/** 步骤签读取的第 4 步视图；不用于判定完成。 */
export type GuideArrangeView = {
  beatId: GuideArrangeBeatId
  title: string
  beatNumber: number
  beatTotal: number
  stage: GuideArrangeStage
  /** 当前需要新建或选用的卡片类别；连线/命名时为 null。 */
  cardKind: GuideCardKind | null
  cardKindLabel: string | null
  /** 当前 place/usage 的目标角色；连线/命名时为 null。 */
  cardRole: GuideArrangeCardRole | null
  /** 当前连线的两个端点角色；顺序不表示方向。 */
  relationRoles: readonly [GuideArrangeCardRole, GuideArrangeCardRole] | null
  /** 已经由用户明确建立的角色绑定，供界面显示，不据此自动跳过。 */
  boundCards: readonly { role: GuideArrangeCardRole; cardId: string }[]
  /** 当前拍已建立、等待命名的普通连线；未建立或已命名完成为 null。 */
  relationId: string | null
  relationFromCardId: string | null
  relationToCardId: string | null
  /** 六拍动作全部完成、等待「编排好了」。 */
  complete: boolean
}

export type GuidePrompt = {
  stepId: GuideStepId
  stepNumber: number
  milestoneId: string | null
  /** 当前动作标题；未填时由步骤标题兜底。 */
  title?: string
  text: string
  tone: GuidePromptTone
  hidden: boolean
  completion?: string
  finishLabel?: string
  /** 操作完成后等待用户确认时显示的主按钮文案。 */
  confirmLabel?: string
}

export type GuideSessionState = {
  stepId: GuideStepId
  milestoneIndex: number
  /** 本步骤第几次进入/重置；导入等异步界面状态据此失效。 */
  stepAttempt: number
  status: GuideSessionStatus
  prompt: GuidePrompt
  collapsed: boolean
  pauseReason: GuidePauseReason | null
  /** 暂停期间观察到的新上下文，恢复时用它判断是否需要重置本步等待。 */
  pendingScope: GuideScopeContext | null
  scope: GuideScopeContext
  savedConfigFingerprint: string | null
  createdProjectId: string | null
  documentCardId: string | null
  /** 第 3 步：当前打开且正文可读的文档卡；关闭编辑器后才推进。 */
  documentEditorCardId: string | null
  /** 第 4 步：script/opening/cue/next-background/两人物状态/music/prompt。 */
  arrangeCards: GuideArrangeBindings
  arrangeRelationId: string | null
  arrangeRelationFromCardId: string | null
  arrangeRelationToCardId: string | null
  generationOperationId: string | null
  /** 第 5 步：生成启动后保持等待，失败后等重试，不以开始请求冒充候选。 */
  generationRunState: GuideGenerationRunState
  /** 第 7 步：预览里有真实未保存改词；只表示有无，不含对白。 */
  dialogueDraftDirty: boolean
  /** 第 7 步当前保存请求；用来区分迟到的确认、失败和清除。 */
  dialogueSaveRequestId: string | null
  /** 当前请求已经结束处理（无改动或放弃）；同一请求的迟到结果不再改界面。 */
  dialogueSaveResolved: boolean
  /** 保存失败/待核对尚未处理；此时不显示跳过。 */
  dialogueSaveUnresolved: boolean
  activeCandidateSnapshotId: string | null
  supersededCandidateSnapshotId: string | null
  candidatePhase: GuideCandidatePhase
  /** 新候选来自修改或丢弃后的重试，候选就绪时换用重玩文案。 */
  candidateReplay: boolean
  /** 最近处理过的事实键，用于忽略同一通知的重复投递。 */
  handledFactKeys: readonly string[]
  /** 本窗口里由真实页面动作确认完成的步骤；导航跳转不会写入。 */
  completedSteps: readonly GuideStepId[]
  /** 第 4 步由真实页面动作确认完成的编排拍；导航跳转不会写入。 */
  completedBeats: readonly GuideArrangeBeatId[]
}

export type GuideEffect =
  | { type: 'open-catalog'; reason: 'unknown-step' }
  | { type: 'overlay-hidden' }
  | { type: 'overlay-shown' }
  | { type: 'paused'; reason: GuidePauseReason | null }
  | { type: 'resumed' }
  | { type: 'step-entered'; stepId: GuideStepId }
  | { type: 'guide-completed' }
  | { type: 'guide-exited' }

export type GuideCommand =
  | { type: 'fact'; fact: GuideFact }
  | { type: 'context-changed'; scope: GuideScopeContext }
  | { type: 'step-selected'; stepId: GuideStepId }
  | { type: 'pause' }
  | { type: 'resume'; scope?: GuideScopeContext }
  | { type: 'collapse' }
  | { type: 'expand' }
  | { type: 'candidate-opened'; candidateSnapshotId: string }
  | { type: 'candidate-returned'; candidateSnapshotId?: string }
  | { type: 'candidate-revised'; candidateSnapshotId?: string }
  | { type: 'candidate-discarded'; candidateSnapshotId?: string }
  | { type: 'confirm-step' }
  | { type: 'skip' }
  | { type: 'skip-model-config' }
  | { type: 'go-previous' }
  | { type: 'go-next' }
  | { type: 'finish' }
  | { type: 'exit' }

export type GuideAdvanceResult = {
  state: GuideSessionState
  effects: readonly GuideEffect[]
}

const MAX_HANDLED_FACT_KEYS = 128

export type GuideRestoreOptions = {
  stepId?: string | null
  /** 上次查看的第 4 步编排拍；只恢复位置，不恢复完成记录。 */
  beatId?: string | null
  scope?: GuideScopeContext
  collapsed?: boolean
}

/** 新建会话。未知 stepId 的恢复由 restoreGuideSession 处理。 */
export function createGuideState(
  options: {
    stepId?: GuideStepId
    beatId?: string | null
    scope?: GuideScopeContext
    collapsed?: boolean
  } = {}
): GuideSessionState {
  const stepId = options.stepId ?? GUIDE_FIRST_STEP_ID
  const step = guideStepById(stepId)
  const collapsed = options.collapsed ?? false
  const state: GuideSessionState = {
    stepId,
    milestoneIndex: 0,
    stepAttempt: 0,
    status: 'following',
    prompt: createActionPrompt(step, collapsed),
    collapsed,
    pauseReason: null,
    pendingScope: null,
    scope: copyScope(options.scope ?? emptyGuideScopeContext()),
    savedConfigFingerprint: null,
    createdProjectId: null,
    documentCardId: null,
    documentEditorCardId: null,
    arrangeCards: {},
    arrangeRelationId: null,
    arrangeRelationFromCardId: null,
    arrangeRelationToCardId: null,
    ...initialGenerationCandidateProgress(),
    ...initialDialogueSaveProgress(),
    handledFactKeys: [],
    completedSteps: [],
    completedBeats: []
  }
  if (stepId !== GUIDE_STEP_ID.arrangeScene || !options.beatId) return state
  if (!isGuideArrangeBeatId(options.beatId)) return state
  const target: GuideNavTarget = { stepId, beatId: options.beatId }
  const milestoneIndex = guideNavUnitMilestoneIndex(target)
  if (milestoneIndex < 0) return state
  return {
    ...state,
    milestoneIndex,
    prompt: guideNavUnitPrompt(state, target)
  }
}

/**
 * 独立入口恢复：没有 lastStepId 从第一步开始；旧 id 已不存在时回第一步并
 * 请求打开目录，不猜用户读到哪一步。
 */
export function restoreGuideSession(options: GuideRestoreOptions = {}): GuideAdvanceResult {
  const baseOptions = { scope: options.scope, collapsed: options.collapsed }
  const stepId = options.stepId
  if (stepId === undefined || stepId === null) {
    return { state: createGuideState(baseOptions), effects: [] }
  }
  if (isGuideStepId(stepId)) {
    return {
      state: createGuideState({ ...baseOptions, stepId, beatId: options.beatId }),
      effects: []
    }
  }
  return {
    state: createGuideState({ ...baseOptions, stepId: GUIDE_FIRST_STEP_ID }),
    effects: [{ type: 'open-catalog', reason: 'unknown-step' }]
  }
}

export function currentGuideMilestone(state: GuideSessionState): GuideMilestone | null {
  return guideStepById(state.stepId).milestones[state.milestoneIndex] ?? null
}

function boundArrangeCards(
  cards: GuideArrangeBindings
): readonly { role: GuideArrangeCardRole; cardId: string }[] {
  return (Object.keys(cards) as GuideArrangeCardRole[])
    .filter((role) => cards[role] !== undefined)
    .map((role) => ({ role, cardId: cards[role] as string }))
}

/**
 * 步骤签只读视图：当前拍、阶段、所需卡片类别和已明确绑定的卡。
 * UI 不据此自行判定完成；完成仍由 advanceGuide 处理事实决定。
 */
export function guideArrangeViewOf(state: GuideSessionState): GuideArrangeView | null {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return null
  const step = guideStepById(state.stepId)
  const beats = step.arrangeBeats ?? GUIDE_ARRANGE_BEATS
  if (beats.length === 0) return null

  const milestone = step.milestones[state.milestoneIndex]
  if (!milestone?.arrange) {
    if (state.milestoneIndex < step.milestones.length) return null
    const last = beats[beats.length - 1]
    return {
      beatId: last.id,
      title: last.title,
      beatNumber: last.number,
      beatTotal: beats.length,
      stage: 'name',
      cardKind: null,
      cardKindLabel: null,
      cardRole: null,
      relationRoles: last.relation,
      boundCards: boundArrangeCards(state.arrangeCards),
      relationId: state.arrangeRelationId,
      relationFromCardId: state.arrangeRelationFromCardId,
      relationToCardId: state.arrangeRelationToCardId,
      complete: true
    }
  }

  const cardKind = milestone.wait.cardKinds?.[0] ?? null
  return {
    beatId: milestone.arrange.beatId,
    title: guideArrangeBeatById(milestone.arrange.beatId).title,
    beatNumber: milestone.arrange.beatNumber,
    beatTotal: milestone.arrange.beatTotal,
    stage: milestone.arrange.stage,
    cardKind,
    cardKindLabel: cardKind ? guideArrangeCardKindLabel(cardKind) : null,
    cardRole: milestone.wait.cardRole ?? null,
    relationRoles: milestone.wait.relationRoles ?? null,
    boundCards: boundArrangeCards(state.arrangeCards),
    relationId: state.arrangeRelationId,
    relationFromCardId: state.arrangeRelationFromCardId,
    relationToCardId: state.arrangeRelationToCardId,
    complete: false
  }
}

export function isGuideTerminal(state: GuideSessionState): boolean {
  return state.status === 'exited'
}

export function advanceGuide(state: GuideSessionState, command: GuideCommand): GuideAdvanceResult {
  switch (command.type) {
    case 'fact':
      return applyFact(state, command.fact)
    case 'context-changed':
      return applyContextChanged(state, command.scope)
    case 'step-selected':
      return applyStepSelected(state, command.stepId)
    case 'pause':
      return applyPause(state)
    case 'resume':
      return applyResume(state, command.scope)
    case 'collapse':
      return applyCollapse(state, true)
    case 'expand':
      return applyCollapse(state, false)
    case 'candidate-opened':
      return applyCandidateCommand(state, 'opened', command.candidateSnapshotId)
    case 'candidate-returned':
      return applyCandidateCommand(state, 'returned', command.candidateSnapshotId)
    case 'candidate-revised':
      return applyCandidateCommand(state, 'revised', command.candidateSnapshotId)
    case 'candidate-discarded':
      return applyCandidateCommand(state, 'discarded', command.candidateSnapshotId)
    case 'confirm-step':
      return applyConfirmStep(state)
    case 'skip':
      return applySkip(state)
    case 'skip-model-config':
      return applySkipModelConfig(state)
    case 'go-previous':
      return applyGoPrevious(state)
    case 'go-next':
      return applyGoNext(state)
    case 'finish':
      return applyFinish(state)
    case 'exit':
      return applyExit(state)
    default:
      return unchanged(state)
  }
}

function applyFact(state: GuideSessionState, fact: GuideFact): GuideAdvanceResult {
  if (state.status === 'exited' || state.status === 'completed' || state.status === 'paused') {
    return unchanged(state)
  }
  const factKey = guideFactKey(fact)
  if (state.handledFactKeys.includes(factKey)) return unchanged(state)

  const handledState: GuideSessionState = {
    ...state,
    handledFactKeys: [...state.handledFactKeys, factKey].slice(-MAX_HANDLED_FACT_KEYS)
  }

  if (!factBelongsToPractice(state.scope, fact)) {
    return { state: handledState, effects: [] }
  }

  // 失败/待核对只更新原位文案，不推进步骤；迟到失败也不能把会话带到旧工程。
  if (fact.outcome !== 'confirmed') {
    switch (fact.kind) {
      case 'configTestFailed':
        return applyConfigTestFailed(handledState)
      case 'dialogueSaveUnsettled':
        return applyDialogueSaveUnsettled(handledState, fact.requestId)
      case 'exportFailed':
        return applyExportFailed(handledState)
      default:
        return { state: handledState, effects: [] }
    }
  }

  // 只有建工程、进入工程等明确事实可以建立工程绑定；其他结果事实不能借
  // 未绑定或部分绑定的练习隐式补全工程/场景/画布。
  const scopedState: GuideSessionState = factEstablishesScope(fact)
    ? {
        ...handledState,
        scope: mergeScope(state.scope, fact.scope)
      }
    : handledState

  return applyConfirmedFact(scopedState, fact)
}

function applyConfirmedFact(state: GuideSessionState, fact: GuideFact): GuideAdvanceResult {
  switch (fact.kind) {
    case 'configTested':
      return applyConfigTested(state)
    case 'configChanged':
      return applyConfigChanged(state)
    case 'configSaved':
      return applyConfigSaved(state, fact.configFingerprint)
    case 'projectCreated':
      return applyProjectCreated(state, fact.scope.projectId)
    case 'projectEntered':
      return applyProjectEntered(state, fact.scope.projectId)
    case 'sourceImported':
      return applySourceImported(state, fact.sourceKind)
    case 'cardCreated':
      return applyCardCreated(state, fact.cardKind, fact.cardId)
    case 'cardSelected':
      return applyCardSelected(state, fact.cardId, fact.cardKind)
    case 'cardDeleted':
      return applyArrangeCardDeleted(state, fact.cardId)
    case 'documentOpened':
      return applyDocumentOpened(state, fact.cardId)
    case 'documentClosed':
      return applyDocumentClosed(state, fact.cardId)
    case 'cardEdited':
      return applyCardEdited(state, fact.cardKind, fact.cardId)
    case 'promptBodySaved':
      return applyPromptBodySaved(state, fact.cardId)
    case 'relationCreated':
      return applyRelationCreated(state, fact)
    case 'relationNamed':
      return applyRelationNamed(state, fact)
    case 'relationDeleted':
      return applyArrangeRelationDeleted(state, fact)
    case 'canvasSaved':
      return applyCanvasSaved(state, fact.reason)
    case 'inputSummaryOpened':
      return applyInputSummaryOpened(state)
    case 'generationStarted':
      return applyGenerationStarted(state, fact.operationId)
    case 'generationFailed':
      return applyGenerationFailed(state, fact.operationId)
    case 'candidateReady':
      if (state.stepId === GUIDE_STEP_ID.saveAndGenerate) {
        return applyGenerationCandidateReady(state, fact.candidateSnapshotId, fact.operationId)
      }
      return applyCandidateReady(state, fact.candidateSnapshotId, fact.operationId)
    case 'candidateOpened':
      return applyCandidateFact(state, 'opened', fact.candidateSnapshotId)
    case 'candidateReturned':
      return applyCandidateReturned(state, fact.candidateSnapshotId)
    case 'candidateAccepted':
      return applyCandidateAccepted(state, fact.candidateSnapshotId, fact.operationId)
    case 'candidateRevised':
      return applyCandidateFact(state, 'revised', fact.candidateSnapshotId, fact.operationId)
    case 'candidateDiscarded':
      return applyCandidateFact(state, 'discarded', fact.candidateSnapshotId)
    case 'dialogueSaveStarted':
      return applyDialogueSaveStarted(state, fact.requestId)
    case 'dialogueSaved':
      return applyDialogueSaved(state, fact.requestId)
    case 'dialogueDraftChanged':
      return applyDialogueDraftChanged(state, fact.dirty)
    case 'dialogueSaveCleared':
      return applyDialogueSaveCleared(state, fact.requestId, fact.clearReason)
    case 'exported':
      return applyExported(state)
    default:
      return unchanged(state)
  }
}

/** 保存完成后要测试的是刚保存的配置；先测试不会抢先完成本步。 */
function applyConfigSaved(state: GuideSessionState, fingerprint: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.configureModel) return unchanged(state)
  if (state.milestoneIndex >= 1 && state.savedConfigFingerprint === fingerprint) {
    return unchanged(state)
  }

  let base = state
  if (state.milestoneIndex >= 1) {
    base = rewindStepProgress(state)
  }

  return completeMilestone({ ...base, savedConfigFingerprint: fingerprint }, 0)
}

function applyConfigTested(state: GuideSessionState): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.configureModel) return unchanged(state)
  if (state.milestoneIndex < 1) return unchanged(state)
  return completeMilestone(state, 1)
}

/** 保存后改动配置：回到本步保存提示，已保存依据失效。 */
function applyConfigChanged(state: GuideSessionState): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.configureModel) return unchanged(state)
  return { state: rewindStepProgress(state), effects: [] }
}

/** 连接测试失败：保留本步等待并显示失败文案，不推进。 */
function applyConfigTestFailed(state: GuideSessionState): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.configureModel) return unchanged(state)
  const step = guideStepById(state.stepId)
  const failure = step.connectionFailure
  if (!failure) return unchanged(state)
  return {
    state: {
      ...state,
      prompt: {
        stepId: step.id,
        stepNumber: step.number,
        milestoneId: 'connection-failed',
        title: failure.title,
        text: failure.prompt,
        tone: 'waiting',
        hidden: state.collapsed
      }
    },
    effects: []
  }
}

function applyProjectCreated(state: GuideSessionState, projectId: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.createProject || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  return completeMilestone({ ...state, createdProjectId: projectId }, 0)
}

function applyProjectEntered(state: GuideSessionState, projectId: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.createProject || state.milestoneIndex !== 1) {
    return unchanged(state)
  }
  if (!state.createdProjectId || projectId !== state.createdProjectId) return unchanged(state)
  return completeMilestone(state, 1)
}

function applySourceImported(state: GuideSessionState, sourceKind: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.importScript || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  if (sourceKind !== 'document') return unchanged(state)
  return completeMilestone(state, 0)
}

function applyCardCreated(
  state: GuideSessionState,
  cardKind: GuideCardKind,
  cardId: string
): GuideAdvanceResult {
  if (state.stepId === GUIDE_STEP_ID.importScript) {
    if (cardKind !== 'document') return unchanged(state)
    if (state.milestoneIndex > 1) return unchanged(state)
    // 已有文档或导入归属未知时，真实拖入文档卡即可从“阅读”继续，不要求重复导入。
    return completeMilestone({ ...state, documentCardId: cardId }, 1)
  }

  if (state.stepId === GUIDE_STEP_ID.arrangeScene) {
    return applyArrangeCardPlaced(state, cardKind, cardId)
  }

  return unchanged(state)
}

/** 用户明确点选已放置的卡：既可作为当前一拍的新卡（复用），也可补绑剧本卡。 */
function applyCardSelected(
  state: GuideSessionState,
  cardId: string,
  cardKind: GuideCardKind
): GuideAdvanceResult {
  if (state.stepId === GUIDE_STEP_ID.importScript) {
    if (cardKind !== 'document') return unchanged(state)
    if (state.milestoneIndex > 1) return unchanged(state)
    return completeMilestone({ ...state, documentCardId: cardId }, 1)
  }

  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)

  let base = state
  if (cardKind === 'document' && !base.arrangeCards.script) {
    const bound = bindArrangeCard(base.arrangeCards, 'script', cardId)
    if (!bound) return unchanged(state)
    base = { ...base, arrangeCards: bound }
  }

  const milestone = currentGuideMilestone(base)
  if (!milestone || milestone.wait.kind !== 'cardCreated') {
    return base === state ? unchanged(state) : { state: base, effects: [] }
  }
  if (!isGuideCardKindOf(cardKind, milestone.wait.cardKinds ?? [])) {
    return base === state ? unchanged(state) : { state: base, effects: [] }
  }
  const role = milestone.wait.cardRole
  if (!role || GUIDE_ARRANGE_CARD_KIND[role] !== cardKind) {
    return base === state ? unchanged(state) : { state: base, effects: [] }
  }
  const bindings = bindArrangeCard(base.arrangeCards, role, cardId)
  if (!bindings) return base === state ? unchanged(state) : { state: base, effects: [] }
  return completeMilestone({ ...base, arrangeCards: bindings }, base.milestoneIndex)
}

function applyArrangeCardPlaced(
  state: GuideSessionState,
  cardKind: GuideCardKind,
  cardId: string
): GuideAdvanceResult {
  const milestone = currentGuideMilestone(state)
  if (!milestone || milestone.wait.kind !== 'cardCreated') return unchanged(state)
  if (!isGuideCardKindOf(cardKind, milestone.wait.cardKinds ?? [])) return unchanged(state)
  const role = milestone.wait.cardRole
  if (!role || GUIDE_ARRANGE_CARD_KIND[role] !== cardKind) return unchanged(state)
  const bindings = bindArrangeCard(state.arrangeCards, role, cardId)
  if (!bindings) return unchanged(state)
  return completeMilestone({ ...state, arrangeCards: bindings }, state.milestoneIndex)
}

function documentEditorPrompt(state: GuideSessionState): GuidePrompt {
  const step = guideStepById(GUIDE_STEP_ID.importScript)
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

function applyDocumentOpened(state: GuideSessionState, cardId: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.importScript) return unchanged(state)
  // 打开编辑器只是停在这里查看或修改正文，不再把「打开」当成读完。
  // 已放在画布上的文档卡直接阅读，也视为选用；不必先重复拖一张新卡。
  if (state.milestoneIndex <= 1) {
    const next: GuideSessionState = {
      ...state,
      documentCardId: cardId,
      documentEditorCardId: cardId,
      milestoneIndex: 2
    }
    return { state: { ...next, prompt: documentEditorPrompt(next) }, effects: [] }
  }
  if (state.milestoneIndex !== 2) return unchanged(state)
  if (!state.documentCardId || cardId !== state.documentCardId) return unchanged(state)
  return {
    state: {
      ...state,
      documentEditorCardId: cardId,
      prompt: documentEditorPrompt(state)
    },
    effects: []
  }
}

function applyDocumentClosed(state: GuideSessionState, cardId: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.importScript) return unchanged(state)
  if (state.milestoneIndex !== 2) return unchanged(state)
  if (!state.documentCardId || cardId !== state.documentCardId) return unchanged(state)
  // 只有实际返回画布才完成第 3 步；保存确认取消时不会发出该事实。
  return completeMilestone({ ...state, documentEditorCardId: null }, 2)
}

function applyCardEdited(
  state: GuideSessionState,
  cardKind: GuideCardKind,
  cardId: string
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)
  const milestone = currentGuideMilestone(state)
  if (!milestone || milestone.wait.kind !== 'cardEdited') return unchanged(state)
  if (!isGuideCardKindOf(cardKind, milestone.wait.cardKinds ?? [])) return unchanged(state)
  const role = milestone.wait.cardRole
  if (!role || state.arrangeCards[role] !== cardId) return unchanged(state)
  return completeMilestone(state, state.milestoneIndex)
}

function applyPromptBodySaved(state: GuideSessionState, cardId: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)
  const milestone = currentGuideMilestone(state)
  if (!milestone || milestone.wait.kind !== 'promptBodySaved') return unchanged(state)
  if (state.arrangeCards.prompt !== cardId) return unchanged(state)
  return completeMilestone(state, state.milestoneIndex)
}

function applyRelationCreated(
  state: GuideSessionState,
  fact: RelationCreatedFact
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)
  const milestone = currentGuideMilestone(state)
  if (!milestone || milestone.wait.kind !== 'relationCreated') return unchanged(state)
  const bindings = resolveArrangeRelation(state.arrangeCards, milestone, fact)
  if (!bindings) return unchanged(state)
  return completeMilestone(
    {
      ...state,
      arrangeCards: bindings,
      arrangeRelationId: fact.relationId,
      arrangeRelationFromCardId: fact.fromCardId,
      arrangeRelationToCardId: fact.toCardId
    },
    state.milestoneIndex
  )
}

function applyRelationNamed(state: GuideSessionState, fact: RelationNamedFact): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)
  const milestone = currentGuideMilestone(state)
  if (!milestone || milestone.wait.kind !== 'relationNamed') return unchanged(state)
  if (!state.arrangeRelationId || state.arrangeRelationId !== fact.relationId) {
    return unchanged(state)
  }
  const sameEndpoints =
    (fact.fromCardId === state.arrangeRelationFromCardId &&
      fact.toCardId === state.arrangeRelationToCardId) ||
    (fact.fromCardId === state.arrangeRelationToCardId &&
      fact.toCardId === state.arrangeRelationFromCardId)
  if (!sameEndpoints) return unchanged(state)
  const resolved = resolveArrangeRelation(state.arrangeCards, milestone, fact)
  if (!resolved) return unchanged(state)
  return completeMilestone(
    {
      ...state,
      arrangeCards: resolved,
      arrangeRelationId: null,
      arrangeRelationFromCardId: null,
      arrangeRelationToCardId: null
    },
    state.milestoneIndex
  )
}

/** 找到卡片当前占用的角色；未绑定返回 null。 */
function arrangeRoleOfCard(
  cards: GuideArrangeBindings,
  cardId: string
): GuideArrangeCardRole | null {
  for (const role of Object.keys(cards) as GuideArrangeCardRole[]) {
    if (cards[role] === cardId) return role
  }
  return null
}

/** 删除已绑定卡后回到该角色第一次就位的拍；剧本卡没有 place 段，回到最早用到它的连线。 */
function arrangeRebindMilestoneIndex(role: GuideArrangeCardRole): number {
  const step = guideStepById(GUIDE_STEP_ID.arrangeScene)
  if (role === 'script') {
    const index = step.milestones.findIndex((milestone) =>
      milestone.wait.relationRoles?.includes('script')
    )
    return index >= 0 ? index : 0
  }
  const index = step.milestones.findIndex((milestone) => milestone.wait.cardRole === role)
  return index >= 0 ? index : 0
}

/** 删除连线后回到对应拍的建线段；两端角色对不上六拍时忽略。 */
function arrangeRelationRebindMilestoneIndex(
  state: GuideSessionState,
  fact: RelationDeletedFact
): number | null {
  const step = guideStepById(GUIDE_STEP_ID.arrangeScene)
  const fromRole = arrangeRoleOfCard(state.arrangeCards, fact.fromCardId)
  const toRole = arrangeRoleOfCard(state.arrangeCards, fact.toCardId)
  if (fromRole && toRole) {
    const beat = GUIDE_ARRANGE_BEATS.find((item) => {
      const [roleA, roleB] = item.relation
      return (roleA === fromRole && roleB === toRole) || (roleA === toRole && roleB === fromRole)
    })
    if (beat) {
      const index = step.milestones.findIndex(
        (milestone) =>
          milestone.arrange?.beatId === beat.id && milestone.wait.kind === 'relationCreated'
      )
      if (index >= 0) return index
    }
  }

  // 端点角色已随卡删除清空时，仍按当前等待的连线本身回到本拍建线段。
  if (state.arrangeRelationId !== fact.relationId) return null
  const beatId = currentGuideMilestone(state)?.arrange?.beatId
  if (!beatId) return null
  const index = step.milestones.findIndex(
    (milestone) => milestone.arrange?.beatId === beatId && milestone.wait.kind === 'relationCreated'
  )
  return index >= 0 ? index : null
}

/** 回到第 4 步某个里程碑时，重建与正常完成路径一致的当前提示。 */
function arrangePromptAt(state: GuideSessionState, milestoneIndex: number): GuidePrompt {
  const step = guideStepById(GUIDE_STEP_ID.arrangeScene)
  const hidden = state.collapsed
  if (milestoneIndex <= 0) {
    return { ...createActionPrompt(step, state.collapsed), hidden }
  }
  const previous = step.milestones[milestoneIndex - 1]
  const current = step.milestones[milestoneIndex]
  if (!previous || !current) return { ...state.prompt, hidden }
  return {
    stepId: step.id,
    stepNumber: step.number,
    milestoneId: current.id,
    title: previous.title,
    text: previous.prompt,
    tone: 'waiting',
    hidden
  }
}

/** 卡片/连线被删后，从对应拍起已完成的记录不再成立。 */
function arrangeCompletionBeforeMilestone(
  state: GuideSessionState,
  milestoneIndex: number
): Pick<GuideSessionState, 'completedBeats' | 'completedSteps'> {
  const step = guideStepById(GUIDE_STEP_ID.arrangeScene)
  const beatNumber = step.milestones[milestoneIndex]?.arrange?.beatNumber
  if (!beatNumber) {
    return { completedBeats: state.completedBeats, completedSteps: state.completedSteps }
  }
  return {
    completedBeats: state.completedBeats.filter(
      (beatId) => guideArrangeBeatById(beatId).number < beatNumber
    ),
    completedSteps: state.completedSteps.filter((stepId) => stepId !== GUIDE_STEP_ID.arrangeScene)
  }
}

/**
 * 已绑定卡删除：清掉该角色，回到对应拍重新选卡。后续事实仍按里程碑匹配，
 * 因此旧卡不能继续完成任何条件；rewind 后等待中的旧连线也一并作废。
 */
function applyArrangeCardDeleted(state: GuideSessionState, cardId: string): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)
  const role = arrangeRoleOfCard(state.arrangeCards, cardId)
  if (!role) return unchanged(state)

  const cards = { ...state.arrangeCards } as Partial<Record<GuideArrangeCardRole, string>>
  delete cards[role]
  const target = arrangeRebindMilestoneIndex(role)
  const rewind = target < state.milestoneIndex
  const pendingTouchesCard =
    state.arrangeRelationFromCardId === cardId || state.arrangeRelationToCardId === cardId

  let next: GuideSessionState = { ...state, arrangeCards: cards }
  if (rewind) {
    next = {
      ...next,
      ...arrangeCompletionBeforeMilestone(state, target),
      milestoneIndex: target,
      stepAttempt: state.stepAttempt + 1,
      prompt: arrangePromptAt(state, target)
    }
  }
  if (rewind || pendingTouchesCard) {
    next = {
      ...next,
      arrangeRelationId: null,
      arrangeRelationFromCardId: null,
      arrangeRelationToCardId: null
    }
  }
  return { state: next, effects: [] }
}

/** 已建连线删除：回到对应拍的建线段，等待用户重新连出并命名。 */
function applyArrangeRelationDeleted(
  state: GuideSessionState,
  fact: RelationDeletedFact
): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.arrangeScene) return unchanged(state)
  const target = arrangeRelationRebindMilestoneIndex(state, fact)
  if (target === null) return unchanged(state)

  const pendingMatches = state.arrangeRelationId === fact.relationId
  const rewind = target < state.milestoneIndex
  if (!rewind && !pendingMatches) return unchanged(state)

  let next: GuideSessionState = state
  if (rewind) {
    next = {
      ...next,
      ...arrangeCompletionBeforeMilestone(state, target),
      milestoneIndex: target,
      stepAttempt: state.stepAttempt + 1,
      prompt: arrangePromptAt(state, target)
    }
  }
  next = {
    ...next,
    arrangeRelationId: null,
    arrangeRelationFromCardId: null,
    arrangeRelationToCardId: null
  }
  return { state: next, effects: [] }
}

function bindArrangeCard(
  cards: GuideArrangeBindings,
  role: GuideArrangeCardRole,
  cardId: string
): GuideArrangeBindings | null {
  const existing = cards[role]
  if (existing !== undefined) return existing === cardId ? cards : null
  for (const otherRole of Object.keys(cards) as GuideArrangeCardRole[]) {
    if (otherRole !== role && cards[otherRole] === cardId) return null
  }
  return { ...cards, [role]: cardId }
}

/**
 * 无向匹配当前拍的两个端点。常规路径要求两张卡都已在前面明确就位；
 * 只有剧本卡允许从用户亲手拉出的连线端点补绑，避免直接跳到第 4 步时
 * 自动扫描同类文档卡。反向拖出同样成立。
 */
function resolveArrangeRelation(
  cards: GuideArrangeBindings,
  milestone: GuideMilestone,
  fact: RelationCreatedFact | RelationNamedFact
): GuideArrangeBindings | null {
  const roles = milestone.wait.relationRoles
  if (!roles) return null
  const [roleA, roleB] = roles
  let resolved = cards

  if (!resolved[roleA] || !resolved[roleB]) {
    if (!roles.includes('script') || resolved.script !== undefined) return null
    const otherRole = roleA === 'script' ? roleB : roleA
    const otherId = resolved[otherRole]
    if (!otherId) return null
    const otherKind = GUIDE_ARRANGE_CARD_KIND[otherRole]
    const otherFrom = fact.fromCardId === otherId && fact.fromCardKind === otherKind
    const otherTo = fact.toCardId === otherId && fact.toCardKind === otherKind
    if (!otherFrom && !otherTo) return null
    const scriptId = otherFrom ? fact.toCardId : fact.fromCardId
    const scriptKind = otherFrom ? fact.toCardKind : fact.fromCardKind
    if (scriptKind !== 'document') return null
    const bound = bindArrangeCard(resolved, 'script', scriptId)
    if (!bound) return null
    resolved = bound
  }

  const idA = resolved[roleA]
  const idB = resolved[roleB]
  if (!idA || !idB || idA === idB) return null
  const kindA = GUIDE_ARRANGE_CARD_KIND[roleA]
  const kindB = GUIDE_ARRANGE_CARD_KIND[roleB]
  const forward =
    fact.fromCardId === idA &&
    fact.toCardId === idB &&
    fact.fromCardKind === kindA &&
    fact.toCardKind === kindB
  const reverse =
    fact.fromCardId === idB &&
    fact.toCardId === idA &&
    fact.fromCardKind === kindB &&
    fact.toCardKind === kindA
  return forward || reverse ? resolved : null
}

function applyExported(state: GuideSessionState): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.exportBuild || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  return completeMilestone(state, 0)
}

/** 导出未成功：原位提示处理，不出现「已导出到」，也不结束阅读。 */
function applyExportFailed(state: GuideSessionState): GuideAdvanceResult {
  if (state.stepId !== GUIDE_STEP_ID.exportBuild || state.milestoneIndex !== 0) {
    return unchanged(state)
  }
  const step = guideStepById(state.stepId)
  const failure = step.exportFailure
  if (!failure) return unchanged(state)
  return {
    state: {
      ...state,
      prompt: {
        ...state.prompt,
        milestoneId: 'export-failed',
        title: failure.title,
        text: failure.prompt,
        tone: 'waiting',
        hidden: state.collapsed,
        completion: undefined
      }
    },
    effects: []
  }
}

function applyContextChanged(
  state: GuideSessionState,
  scope: GuideScopeContext
): GuideAdvanceResult {
  if (state.status === 'exited' || state.status === 'completed') return unchanged(state)

  if (state.status === 'paused') {
    if (state.pendingScope === null || isMeaningfulScopeChange(state.pendingScope, scope)) {
      return { state: { ...state, pendingScope: copyScope(scope) }, effects: [] }
    }
    return unchanged(state)
  }

  if (isMeaningfulScopeChange(state.scope, scope)) {
    return {
      state: pauseWithScope(state, scope),
      effects: [{ type: 'paused', reason: 'scope-changed' }]
    }
  }

  return { state: { ...state, scope: mergeScope(state.scope, scope) }, effects: [] }
}

function applyStepSelected(state: GuideSessionState, stepId: GuideStepId): GuideAdvanceResult {
  if (state.status === 'exited') return unchanged(state)
  const step = guideStepById(stepId)
  // 目录跳步只换当前步骤，不写也不清空真实页面动作留下的完成记录。
  const next = enterStep({ ...state, status: 'following' }, step)
  return {
    state: { ...next, prompt: { ...next.prompt, completion: '已跳到这一步。' } },
    effects: [{ type: 'step-entered', stepId }]
  }
}

function applyPause(state: GuideSessionState): GuideAdvanceResult {
  if (state.status !== 'following') return unchanged(state)
  return {
    state: {
      ...pauseWithScope(state, state.pendingScope),
      pauseReason: null
    },
    effects: [{ type: 'paused', reason: null }]
  }
}

function applyResume(state: GuideSessionState, scope?: GuideScopeContext): GuideAdvanceResult {
  if (state.status !== 'paused') return unchanged(state)

  const nextScope = resumeGuideScope(state.scope, state.pendingScope, scope)
  const changed = isMeaningfulScopeChange(state.scope, nextScope)
  const base: GuideSessionState = {
    ...state,
    status: 'following',
    pauseReason: null,
    pendingScope: null,
    scope: mergeScope(state.scope, nextScope)
  }

  // 第 1 步的配置结论不属于某个工程/场景，换工程后仍可沿用；其余步骤的
  // 对象绑定都落在旧上下文里，不能在未验证的新上下文里猜已完成。
  if (changed && base.stepId !== GUIDE_STEP_ID.configureModel) {
    const rewound = rewindStepProgress(base)
    return {
      state: rewound,
      effects: [{ type: 'resumed' }, { type: 'step-entered', stepId: rewound.stepId }]
    }
  }

  return {
    state: {
      ...base,
      prompt: promptForProgress(base)
    },
    effects: [{ type: 'resumed' }]
  }
}

function applyCollapse(state: GuideSessionState, collapsed: boolean): GuideAdvanceResult {
  if (state.status === 'exited') return unchanged(state)
  if (state.collapsed === collapsed) return unchanged(state)

  const hidden = collapsed
  return {
    state: {
      ...state,
      collapsed,
      prompt: { ...state.prompt, hidden }
    },
    effects: collapsed ? [{ type: 'overlay-hidden' }] : hidden ? [] : [{ type: 'overlay-shown' }]
  }
}

function applyConfirmStep(state: GuideSessionState): GuideAdvanceResult {
  if (state.status !== 'following') return unchanged(state)
  const step = guideStepById(state.stepId)
  if (!step.confirmLabel || state.milestoneIndex < step.milestones.length) {
    return unchanged(state)
  }
  const milestone = step.milestones[step.milestones.length - 1]
  return advancePastStep(state, milestone)
}

function applySkip(state: GuideSessionState): GuideAdvanceResult {
  if (state.status !== 'following') return unchanged(state)
  const step = guideStepById(state.stepId)
  if (!step.skippable) return unchanged(state)
  return completeMilestone(
    state,
    step.milestones.length - 1,
    { completion: '已跳过台词微调。' },
    true
  )
}

/** 已有可用配置时的显式跳过；不生成测试或保存事实。 */
function applySkipModelConfig(state: GuideSessionState): GuideAdvanceResult {
  if (state.status !== 'following') return unchanged(state)
  if (state.stepId !== GUIDE_STEP_ID.configureModel) return unchanged(state)
  const step = guideStepById(state.stepId)
  return advancePastStep(state, step.milestones[0], '已跳过模型设置。')
}

/**
 * 上一步/下一步只移动当前查看位置。跳转不调用完成里程碑，
 * 因此未完成步骤被跳过时不会写入 completedSteps / completedBeats。
 */
function applyGoPrevious(state: GuideSessionState): GuideAdvanceResult {
  return goToNavUnit(state, guidePreviousNavUnit(state))
}

function applyGoNext(state: GuideSessionState): GuideAdvanceResult {
  return goToNavUnit(state, guideNextNavUnit(state))
}

function goToNavUnit(state: GuideSessionState, target: GuideNavUnit | null): GuideAdvanceResult {
  if (!target) return unchanged(state)
  if (state.status !== 'following' && state.status !== 'completed') return unchanged(state)
  return { state: enterNavUnit(state, target), effects: [] }
}

function enterNavUnit(state: GuideSessionState, target: GuideNavTarget): GuideSessionState {
  const step = guideStepById(target.stepId)
  let base = state
  if (state.stepId !== step.id) {
    base = enterStep(state, step, {
      scriptCardId:
        step.id === GUIDE_STEP_ID.arrangeScene && state.stepId === GUIDE_STEP_ID.importScript
          ? state.documentCardId
          : null
    })
  }

  if (step.id === GUIDE_STEP_ID.arrangeScene && target.beatId) {
    const milestoneIndex = guideNavUnitMilestoneIndex(target)
    if (milestoneIndex >= 0) {
      const positioned =
        state.stepId === step.id
          ? {
              ...base,
              stepAttempt: state.stepAttempt + 1,
              status: 'following' as const,
              pauseReason: null,
              pendingScope: null,
              arrangeRelationId: null,
              arrangeRelationFromCardId: null,
              arrangeRelationToCardId: null
            }
          : base
      return {
        ...positioned,
        milestoneIndex,
        prompt: guideNavUnitPrompt(positioned, target)
      }
    }
  }

  return { ...base, status: 'following', pauseReason: null, pendingScope: null }
}

function applyFinish(state: GuideSessionState): GuideAdvanceResult {
  // 第 8 步允许未导出就结束阅读；只退出教程，不产生导出或完成事实。
  if (state.stepId !== GUIDE_STEP_ID.exportBuild) return unchanged(state)
  if (state.status !== 'following' && state.status !== 'completed') return unchanged(state)
  return {
    state: {
      ...state,
      status: 'exited',
      prompt: { ...state.prompt, hidden: true }
    },
    effects: [{ type: 'guide-exited' }]
  }
}

function applyExit(state: GuideSessionState): GuideAdvanceResult {
  if (state.status === 'exited') return unchanged(state)
  return {
    state: {
      ...state,
      status: 'exited',
      prompt: { ...state.prompt, hidden: true }
    },
    effects: [{ type: 'guide-exited' }]
  }
}

function pauseWithScope(
  state: GuideSessionState,
  pendingScope: GuideScopeContext | null
): GuideSessionState {
  const step = guideStepById(state.stepId)
  const milestone = step.milestones[state.milestoneIndex]
  return {
    ...state,
    status: 'paused',
    pauseReason: pendingScope ? 'scope-changed' : null,
    pendingScope: pendingScope ? copyScope(pendingScope) : state.pendingScope,
    prompt: {
      stepId: step.id,
      stepNumber: step.number,
      milestoneId: milestone?.id ?? null,
      title: '跟做已停在这里',
      text: '已暂停跟随当前操作。确认继续后，会从本步骤尚未完成的动作重新等待。',
      tone: 'paused',
      hidden: state.collapsed
    }
  }
}

/** 回到当前步骤开头，清掉本步对象绑定；切换上下文或测试结论失效时使用。 */
function rewindStepProgress(state: GuideSessionState): GuideSessionState {
  const step = guideStepById(state.stepId)
  return {
    ...state,
    milestoneIndex: 0,
    stepAttempt: state.stepAttempt + 1,
    status: 'following',
    pauseReason: null,
    pendingScope: null,
    prompt: createActionPrompt(step, state.collapsed),
    savedConfigFingerprint: null,
    createdProjectId: null,
    documentCardId: null,
    documentEditorCardId: null,
    arrangeCards: {},
    arrangeRelationId: null,
    arrangeRelationFromCardId: null,
    arrangeRelationToCardId: null,
    ...initialGenerationCandidateProgress(),
    ...initialDialogueSaveProgress(),
    completedBeats: state.stepId === GUIDE_STEP_ID.arrangeScene ? [] : state.completedBeats,
    completedSteps: state.completedSteps.filter((stepId) => stepId !== state.stepId)
  }
}
