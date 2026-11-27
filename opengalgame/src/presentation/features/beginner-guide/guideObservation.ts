/**
 * 新手指引观察契约。
 *
 * 页面和业务代码不 import 本文件：由 app/ 层的映射器把已确认的创作者动作翻译成
 * GuideFact，再交给新手引导。这里只描述事实、上下文快照和只读订阅入口，不读取
 * 业务状态，也不保存动作历史。
 */

export type GuideFactOutcome = 'confirmed' | 'cancelled' | 'failed' | 'unverified'

export type GuideSaveReason = 'manual' | 'periodic' | 'beforeGeneration'

export type GuideSourceKind = 'document' | 'image' | 'audio' | 'video'

/** 画布素材卡中的画面与声音种类；不含文档、提示词、动画和特效卡。 */
export type GuideAssetCardKind = 'image' | 'audio' | 'video'

export const GUIDE_MEDIA_KINDS: readonly GuideAssetCardKind[] = ['image', 'audio', 'video']

/**
 * 第 4 步选材所需的已确认来源类别。null 表示文件区尚未读定，不能当成“没有”。
 * 只携带类别布尔值，不含文件名、目录或正文。
 */
export type GuideMediaAvailability = Readonly<Record<GuideAssetCardKind, boolean | null>>

export const UNKNOWN_GUIDE_MEDIA_AVAILABILITY: GuideMediaAvailability = {
  image: null,
  audio: null,
  video: null
}

export type GuideCardKind = GuideSourceKind | 'prompt' | 'animation' | 'effect'

export type GuideFactKind =
  | 'configTested'
  | 'configTestFailed'
  | 'configChanged'
  | 'configSaved'
  | 'projectCreated'
  | 'projectEntered'
  | 'sourceImported'
  | 'cardCreated'
  | 'cardSelected'
  | 'cardDeleted'
  | 'documentOpened'
  | 'documentClosed'
  | 'cardEdited'
  | 'promptBodySaved'
  | 'relationCreated'
  | 'relationNamed'
  | 'relationDeleted'
  | 'canvasSaved'
  | 'inputSummaryOpened'
  | 'generationStarted'
  | 'generationFailed'
  | 'candidateReady'
  | 'candidateOpened'
  | 'candidateReturned'
  | 'candidateAccepted'
  | 'candidateRevised'
  | 'candidateDiscarded'
  | 'dialogueSaveStarted'
  | 'dialogueSaved'
  | 'dialogueSaveUnsettled'
  | 'dialogueDraftChanged'
  | 'dialogueSaveCleared'
  | 'exported'
  | 'exportFailed'

export const GUIDE_FACT_KINDS: readonly GuideFactKind[] = [
  'configTested',
  'configTestFailed',
  'configChanged',
  'configSaved',
  'projectCreated',
  'projectEntered',
  'sourceImported',
  'cardCreated',
  'cardSelected',
  'cardDeleted',
  'documentOpened',
  'documentClosed',
  'cardEdited',
  'promptBodySaved',
  'relationCreated',
  'relationNamed',
  'relationDeleted',
  'canvasSaved',
  'inputSummaryOpened',
  'generationStarted',
  'generationFailed',
  'candidateReady',
  'candidateOpened',
  'candidateReturned',
  'candidateAccepted',
  'candidateRevised',
  'candidateDiscarded',
  'dialogueSaveStarted',
  'dialogueSaved',
  'dialogueSaveUnsettled',
  'dialogueDraftChanged',
  'dialogueSaveCleared',
  'exported',
  'exportFailed'
]

export const GUIDE_FACT_OUTCOMES: readonly GuideFactOutcome[] = [
  'confirmed',
  'cancelled',
  'failed',
  'unverified'
]

export const GUIDE_SAVE_REASONS: readonly GuideSaveReason[] = [
  'manual',
  'periodic',
  'beforeGeneration'
]

export const GUIDE_SOURCE_KINDS: readonly GuideSourceKind[] = [
  'document',
  'image',
  'audio',
  'video'
]

export const GUIDE_CARD_KINDS: readonly GuideCardKind[] = [
  'document',
  'image',
  'audio',
  'video',
  'prompt',
  'animation',
  'effect'
]

/** 事实所属的工程/场景/画布；离开工作台时可以是 null。 */
export type GuideScope = {
  projectId: string | null
  sceneId?: string | null
  canvasId?: string | null
}

export type GuideProjectScope = GuideScope & {
  projectId: string
}

/** 只用于匹配的当前上下文，不含名称、路径或正文。 */
export type GuideScopeContext = {
  projectId: string | null
  sceneId: string | null
  canvasId: string | null
}

type GuideFactBase = {
  scope: GuideScope
  outcome: GuideFactOutcome
  /** 由 app 层保证单调递增；用于去重。 */
  sequence: number
  occurredAt: string
  operationId?: string
  candidateSnapshotId?: string
  configFingerprint?: string
  reason?: GuideSaveReason
}

export type ConfigTestedFact = GuideFactBase & {
  kind: 'configTested'
  configFingerprint: string
}

/** 测试已确认失败；只用于原位提示，不推进或保存。 */
export type ConfigTestFailedFact = GuideFactBase & {
  kind: 'configTestFailed'
  configFingerprint: string
}

/** 测试过或保存过的配置被改动；回到测试提示，不沿用旧结论。 */
export type ConfigChangedFact = GuideFactBase & {
  kind: 'configChanged'
}

export type ConfigSavedFact = GuideFactBase & {
  kind: 'configSaved'
  configFingerprint: string
}

export type ProjectCreatedFact = GuideFactBase & {
  kind: 'projectCreated'
  scope: GuideProjectScope
}

export type ProjectEnteredFact = GuideFactBase & {
  kind: 'projectEntered'
  scope: GuideProjectScope
}

export type SourceImportedFact = GuideFactBase & {
  kind: 'sourceImported'
  sourceId: string
  sourceKind: GuideSourceKind
}

export type CardCreatedFact = GuideFactBase & {
  kind: 'cardCreated'
  cardId: string
  cardKind: GuideCardKind
}

/** 用户在当前画布上明确点选一张已放置的卡；用于复用，不靠扫描同类卡。 */
export type CardSelectedFact = GuideFactBase & {
  kind: 'cardSelected'
  cardId: string
  cardKind: GuideCardKind
}

/** 画布上的卡已确认删除；教程据此解除对应角色绑定。 */
export type CardDeletedFact = GuideFactBase & {
  kind: 'cardDeleted'
  cardId: string
  cardKind: GuideCardKind
}

export type DocumentOpenedFact = GuideFactBase & {
  kind: 'documentOpened'
  cardId: string
}

/** 用户实际关闭文档编辑器、回到画布；打开本身不推进第 3 步。 */
export type DocumentClosedFact = GuideFactBase & {
  kind: 'documentClosed'
  cardId: string
}

export type CardEditedFact = GuideFactBase & {
  kind: 'cardEdited'
  cardId: string
  cardKind: GuideCardKind
}

/** 提示词正文真正写入服务端后的事实；本地草稿和输入停顿都不算。 */
export type PromptBodySavedFact = GuideFactBase & {
  kind: 'promptBodySaved'
  cardId: string
}

/** 普通连线两端；方向不表示先后，按无向端点集匹配。 */
type RelationFactBase = GuideFactBase & {
  relationId: string
  fromCardId: string
  toCardId: string
  fromCardKind: GuideCardKind
  toCardKind: GuideCardKind
}

export type RelationCreatedFact = RelationFactBase & {
  kind: 'relationCreated'
}

export type RelationNamedFact = RelationFactBase & {
  kind: 'relationNamed'
}

/** 普通连线已确认删除；保留两端身份，供教程回到对应拍重建。 */
export type RelationDeletedFact = RelationFactBase & {
  kind: 'relationDeleted'
}

export type CanvasSavedFact = GuideFactBase & {
  kind: 'canvasSaved'
  reason: GuideSaveReason
}

export type InputSummaryOpenedFact = GuideFactBase & {
  kind: 'inputSummaryOpened'
}

export type GenerationStartedFact = GuideFactBase & {
  kind: 'generationStarted'
  operationId: string
  /** 启动前保存已确认；缺省视为未验证，保持旧事实可读。 */
  saveVerified?: boolean
}

/** 已确认终止的生成失败；不含失败原因或正文，原因留在原页面。 */
export type GenerationFailedFact = GuideFactBase & {
  kind: 'generationFailed'
  operationId: string
}

export type CandidateReadyFact = GuideFactBase & {
  kind: 'candidateReady'
  candidateSnapshotId: string
  /** 候选预览当前可用；缺省视为未验证，保持旧事实可读。 */
  previewAvailable?: boolean
}

export type CandidateOpenedFact = GuideFactBase & {
  kind: 'candidateOpened'
  candidateSnapshotId: string
}

export type CandidateReturnedFact = GuideFactBase & {
  kind: 'candidateReturned'
}

/** 正式提交成功后的接受事实；同一个候选也只有这次操作可推进第 6 步。 */
export type CandidateAcceptedFact = GuideFactBase & {
  kind: 'candidateAccepted'
  candidateSnapshotId: string
  operationId: string
}

export type CandidateRevisedFact = GuideFactBase & {
  kind: 'candidateRevised'
  candidateSnapshotId: string
}

export type CandidateDiscardedFact = GuideFactBase & {
  kind: 'candidateDiscarded'
  candidateSnapshotId: string
}

export type DialogueSaveStartedFact = GuideFactBase & {
  kind: 'dialogueSaveStarted'
  requestId: string
}

export type DialogueSavedFact = GuideFactBase & {
  kind: 'dialogueSaved'
  requestId?: string
  revision?: number
}

/** 保存失败或待核对；只显示原位状态，不推进到导出。 */
export type DialogueSaveUnsettledFact = GuideFactBase & {
  kind: 'dialogueSaveUnsettled'
  requestId?: string
}

/** 预览里出现了真实未保存改词；只表示有无，不含对白。 */
export type DialogueDraftChangedFact = GuideFactBase & {
  kind: 'dialogueDraftChanged'
  dirty: boolean
}

/** 未处理的保存已结算为无改动，或用户明确放弃草稿退出；不合成保存成功。 */
export type DialogueSaveClearedFact = GuideFactBase & {
  kind: 'dialogueSaveCleared'
  requestId?: string
  clearReason: 'unchanged' | 'abandoned'
}

export type ExportedFact = GuideFactBase & {
  kind: 'exported'
  sceneId?: string
}

/** 导出未成功；只显示原位状态，不产生导出成功事实。 */
export type ExportFailedFact = GuideFactBase & {
  kind: 'exportFailed'
}

export type GuideFact =
  | ConfigTestedFact
  | ConfigTestFailedFact
  | ConfigChangedFact
  | ConfigSavedFact
  | ProjectCreatedFact
  | ProjectEnteredFact
  | SourceImportedFact
  | CardCreatedFact
  | CardSelectedFact
  | CardDeletedFact
  | DocumentOpenedFact
  | DocumentClosedFact
  | CardEditedFact
  | PromptBodySavedFact
  | RelationCreatedFact
  | RelationNamedFact
  | RelationDeletedFact
  | CanvasSavedFact
  | InputSummaryOpenedFact
  | GenerationStartedFact
  | GenerationFailedFact
  | CandidateReadyFact
  | CandidateOpenedFact
  | CandidateReturnedFact
  | CandidateAcceptedFact
  | CandidateRevisedFact
  | CandidateDiscardedFact
  | DialogueSaveStartedFact
  | DialogueSavedFact
  | DialogueSaveUnsettledFact
  | DialogueDraftChangedFact
  | DialogueSaveClearedFact
  | ExportedFact
  | ExportFailedFact

export type GuidePage =
  'home' | 'project-list' | 'workbench' | 'candidate-preview' | 'connection-settings' | 'unknown'

export type GuideSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'unsaved'
  | 'committedUnsubmitted'
  | 'unverified'
  | 'failed'
  | 'unknown'

export type GuideArrangementStatus = 'unknown' | 'idle' | 'loading' | 'ready' | 'empty' | 'failed'

/**
 * 当前环境快照。只用于状态型里程碑的起点匹配，不会回放历史事实。
 */
export type GuideContextSnapshot = {
  page: GuidePage
  projectId: string | null
  sceneId: string | null
  canvasId: string | null
  documentLayerCardId: string | null
  saveState: GuideSaveState
  arrangementStatus: GuideArrangementStatus
  /** 试玩预览以模态层打开；教程在此期间不显示也不进入 Tab 序列。 */
  previewOpen: boolean
  /** 生成抽屉已打开；教程据此挂进抽屉内容的顶层槽位，避免被模态遮挡。 */
  generationDrawerOpen: boolean
  /** 当前工程已确认的来源类别；目录未读定时为 null，不能据此断言没有素材。 */
  mediaAvailability: GuideMediaAvailability
  /** 当前画布卡片 id → 显示名；只用于教程徽标，不含正文或路径。 */
  cardTitles?: Readonly<Record<string, string>>
}

export const EMPTY_GUIDE_CONTEXT: GuideContextSnapshot = {
  page: 'unknown',
  projectId: null,
  sceneId: null,
  canvasId: null,
  documentLayerCardId: null,
  saveState: 'unknown',
  arrangementStatus: 'unknown',
  previewOpen: false,
  generationDrawerOpen: false,
  mediaAvailability: UNKNOWN_GUIDE_MEDIA_AVAILABILITY
}

export type GuideObservationListener = (fact: GuideFact) => void
export type GuideContextListener = (snapshot: GuideContextSnapshot) => void

export interface GuideObservationSource {
  /** 开始接收事实；返回解除订阅的函数。 */
  subscribe(listener: GuideObservationListener): () => void
  /** 读取当前环境；不返回历史事实。 */
  readCurrent(): GuideContextSnapshot
  /** 页面上下文变化（工程、场景、画布、试玩预览）；教程据此暂停或隔离。 */
  subscribeContext?(listener: GuideContextListener): () => void
  /** 只订阅试玩预览开关，供教程未进入阅读时也避开预览模态层。 */
  subscribePreview?(listener: (open: boolean) => void): () => void
}

export function createEmptyGuideObservationSource(): GuideObservationSource {
  return {
    subscribe(): () => void {
      return () => undefined
    },
    readCurrent(): GuideContextSnapshot {
      return { ...EMPTY_GUIDE_CONTEXT }
    },
    subscribeContext(): () => void {
      return () => undefined
    },
    subscribePreview(): () => void {
      return () => undefined
    }
  }
}

export function emptyGuideScopeContext(): GuideScopeContext {
  return { projectId: null, sceneId: null, canvasId: null }
}

export function guideScopeContextOf(snapshot: GuideContextSnapshot): GuideScopeContext {
  return {
    projectId: snapshot.projectId,
    sceneId: snapshot.sceneId,
    canvasId: snapshot.canvasId
  }
}

const guideFactKindSet: ReadonlySet<string> = new Set(GUIDE_FACT_KINDS)
const guideFactOutcomeSet: ReadonlySet<string> = new Set(GUIDE_FACT_OUTCOMES)
const guideSaveReasonSet: ReadonlySet<string> = new Set(GUIDE_SAVE_REASONS)
const guideSourceKindSet: ReadonlySet<string> = new Set(GUIDE_SOURCE_KINDS)
const guideCardKindSet: ReadonlySet<string> = new Set(GUIDE_CARD_KINDS)

export function isGuideFactKind(value: unknown): value is GuideFactKind {
  return typeof value === 'string' && guideFactKindSet.has(value)
}

export function isGuideFactOutcome(value: unknown): value is GuideFactOutcome {
  return typeof value === 'string' && guideFactOutcomeSet.has(value)
}

export function isGuideSaveReason(value: unknown): value is GuideSaveReason {
  return typeof value === 'string' && guideSaveReasonSet.has(value)
}

export function isGuideSourceKind(value: unknown): value is GuideSourceKind {
  return typeof value === 'string' && guideSourceKindSet.has(value)
}

export function isGuideCardKind(value: unknown): value is GuideCardKind {
  return typeof value === 'string' && guideCardKindSet.has(value)
}

export function isGuideCardKindOf(kind: GuideCardKind, allowed: readonly GuideCardKind[]): boolean {
  return allowed.includes(kind)
}

export function isAssetCardKind(kind: GuideCardKind): kind is GuideAssetCardKind {
  return kind === 'image' || kind === 'audio' || kind === 'video'
}

export function isConfirmedGuideFact(fact: GuideFact): boolean {
  return fact.outcome === 'confirmed'
}

export function guideFactKey(fact: GuideFact): string {
  return `${fact.kind}:${fact.sequence}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isGuideScope(value: unknown): value is GuideScope {
  if (!isRecord(value)) return false
  if (typeof value.projectId !== 'string' && value.projectId !== null) return false
  if (!isOptionalString(value.sceneId)) return false
  if (!isOptionalString(value.canvasId)) return false
  return true
}

/**
 * 运行时守卫：只校验跨模块共享的公共字段和各 kind 的必备字段。
 * 不校验业务合法性，业务合法性由 app/ 层映射器负责。
 */
export function isGuideFact(value: unknown): value is GuideFact {
  if (!isRecord(value)) return false
  if (!isGuideFactKind(value.kind)) return false
  if (!isGuideFactOutcome(value.outcome)) return false
  if (typeof value.sequence !== 'number' || !Number.isFinite(value.sequence)) return false
  if (typeof value.occurredAt !== 'string') return false
  const scope = value.scope
  if (!isGuideScope(scope)) return false
  if (!isOptionalString(value.operationId)) return false
  if (!isOptionalString(value.candidateSnapshotId)) return false
  if (!isOptionalString(value.configFingerprint)) return false
  if (value.reason !== undefined && !isGuideSaveReason(value.reason)) return false

  switch (value.kind) {
    case 'configTested':
    case 'configTestFailed':
    case 'configSaved':
      return typeof value.configFingerprint === 'string'
    case 'configChanged':
      return true
    case 'projectCreated':
    case 'projectEntered':
      return typeof scope.projectId === 'string'
    case 'sourceImported':
      return typeof value.sourceId === 'string' && isGuideSourceKind(value.sourceKind)
    case 'cardCreated':
      return typeof value.cardId === 'string' && isGuideCardKind(value.cardKind)
    case 'cardSelected':
    case 'cardDeleted':
      return typeof value.cardId === 'string' && isGuideCardKind(value.cardKind)
    case 'documentOpened':
    case 'documentClosed':
      return typeof value.cardId === 'string'
    case 'cardEdited':
      return typeof value.cardId === 'string' && isGuideCardKind(value.cardKind)
    case 'promptBodySaved':
      return typeof value.cardId === 'string'
    case 'relationCreated':
    case 'relationNamed':
    case 'relationDeleted':
      return (
        typeof value.relationId === 'string' &&
        typeof value.fromCardId === 'string' &&
        typeof value.toCardId === 'string' &&
        isGuideCardKind(value.fromCardKind) &&
        isGuideCardKind(value.toCardKind)
      )
    case 'canvasSaved':
      return isGuideSaveReason(value.reason)
    case 'inputSummaryOpened':
      return true
    case 'generationStarted':
      return typeof value.operationId === 'string' && isOptionalBoolean(value.saveVerified)
    case 'generationFailed':
      return typeof value.operationId === 'string'
    case 'candidateReady':
      return (
        typeof value.candidateSnapshotId === 'string' && isOptionalBoolean(value.previewAvailable)
      )
    case 'candidateOpened':
    case 'candidateRevised':
    case 'candidateDiscarded':
      return typeof value.candidateSnapshotId === 'string'
    case 'candidateAccepted':
      return (
        typeof value.candidateSnapshotId === 'string' &&
        typeof value.operationId === 'string' &&
        value.operationId.length > 0
      )
    case 'candidateReturned':
      return true
    case 'dialogueSaveStarted':
      return typeof value.requestId === 'string' && value.requestId.length > 0
    case 'dialogueSaved':
      return (
        isOptionalString(value.requestId) &&
        (value.revision === undefined ||
          (typeof value.revision === 'number' && Number.isFinite(value.revision)))
      )
    case 'dialogueSaveUnsettled':
      return isOptionalString(value.requestId)
    case 'dialogueDraftChanged':
      return typeof value.dirty === 'boolean'
    case 'dialogueSaveCleared':
      return (
        isOptionalString(value.requestId) &&
        (value.clearReason === 'unchanged' || value.clearReason === 'abandoned')
      )
    case 'exported':
      return isOptionalString(value.sceneId)
    case 'exportFailed':
      return true
  }
}
