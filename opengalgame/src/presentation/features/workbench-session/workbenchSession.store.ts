import { create } from 'zustand'

import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type {
  SceneCanvasArrangementVO,
  SceneCanvasCardVO
} from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { FailureState } from '../../feedback/failure'
import { promptReferenceIds } from './promptReferences'
import {
  arrangementDraftOf,
  cloneCard,
  cloneSnapshot,
  draftFingerprint,
  retainSourceDetails,
  snapshotFingerprint,
  snapshotOf
} from './workbenchSessionMapper'
import {
  FIRST_SCENE_LABEL,
  HISTORY_LIMIT,
  type PromptReferenceAlert,
  type SessionCardLayout,
  type SessionSnapshot,
  type SessionViewport,
  type WorkbenchSaveState,
  type WorkbenchSessionState
} from './workbenchSession.types'

const emptyIdentity = {
  projectId: '',
  projectName: '',
  sceneId: '',
  canvasId: '',
  sceneLabel: FIRST_SCENE_LABEL
}

const initialState: WorkbenchSessionState = {
  ...emptyIdentity,
  catalogStatus: 'idle',
  catalogError: null,
  sources: [],
  sourceDetails: {},
  arrangementStatus: 'idle',
  arrangementError: null,
  inspectionDiagnostics: [],
  cards: [],
  relations: [],
  selectedCardId: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  documentLayerCardId: null,
  baseline: null,
  past: [],
  future: [],
  saveState: 'idle',
  saveError: null,
  promptReferenceAlert: null,
  pageBlocked: false,
  revision: 0,
  structuralRevision: 0,
  cardEditRevisions: {},
  layoutRevisions: {},
  viewportRevision: 0
}

type ArrangementCapture = {
  revision: number
  structuralRevision: number
}

type WorkbenchSessionActions = {
  startSession: (project: {
    projectId: string
    projectName: string
    sceneId: string
    canvasId: string
  }) => void
  reset: () => void
  setCatalog: (sources: readonly ProjectInputSourceSummaryVO[]) => void
  setCatalogFailure: (error: FailureState) => void
  setArrangement: (
    arrangement: SceneCanvasArrangementVO,
    options?: { baseline?: SceneCanvasArrangementVO }
  ) => void
  setArrangementEmpty: () => void
  setArrangementFailure: (error: FailureState) => void
  putSourceDetails: (sources: readonly ProjectInputSourceVO[]) => void
  setInspectionDiagnostics: (diagnostics: WorkbenchSessionState['inspectionDiagnostics']) => void
  setPageBlocked: (blocked: boolean) => void
  selectCard: (cardId: string | null) => void
  openDocumentLayer: (cardId: string) => void
  closeDocumentLayer: () => void
  setViewport: (viewport: SessionViewport) => void
  moveCards: (moves: readonly { cardId: string; x: number; y: number }[]) => boolean
  resizeCard: (cardId: string, layout: SessionCardLayout) => boolean
  applyFittedLayout: (cardId: string, layout: SessionCardLayout) => boolean
  setPromptBodyDraft: (cardId: string, body: string, recordHistory: boolean) => boolean
  /** 以稳定 cardId 集合替换提示词引用；顺序保留，重复身份只记一次。 */
  setPromptReferences: (cardId: string, referenceCardIds: readonly string[]) => boolean
  setPromptReferenceAlert: (alert: PromptReferenceAlert | null) => void
  applyServerArrangement: (
    arrangement: SceneCanvasArrangementVO,
    capture: ArrangementCapture
  ) => boolean
  markSaving: () => void
  markSaved: (sent: SessionSnapshot) => void
  markSaveFailure: (state: WorkbenchSaveState, error: FailureState) => void
  /** 把撤销前草稿放回当前会话，作为新的未保存编辑，不恢复旧撤销栈。 */
  restoreSessionDraft: (snapshot: SessionSnapshot) => void
  undo: () => void
  redo: () => void
}

type Store = WorkbenchSessionState & WorkbenchSessionActions

/** 工作台当前会话。只保存前端草稿，保存与撤销排程由命令层承担。 */
export const useWorkbenchSessionStore = create<Store>((set, get) => ({
  ...initialState,
  /** 打开工程后重置会话并记下身份。 */
  startSession: (project) =>
    set({
      ...emptyIdentity,
      projectId: project.projectId,
      projectName: project.projectName,
      sceneId: project.sceneId,
      canvasId: project.canvasId,
      promptReferenceAlert: null,
      catalogStatus: 'loading',
      arrangementStatus: 'loading'
    }),
  /** 离开工作台时清空会话。 */
  reset: () => set(initialState),
  setCatalog: (sources) => {
    const state = get()
    const sourceDetails = retainSourceDetails(sources, state.sourceDetails)
    set({
      sources,
      sourceDetails,
      catalogStatus: sources.length === 0 ? 'empty' : 'ready',
      catalogError: null
    })
  },
  /**
   * 记录来源扫描失败。已有列表时保留摘要，不解释成空目录。
   * @param error - 失败状态。
   */
  setCatalogFailure: (error) => {
    const { catalogStatus } = get()
    if (catalogStatus === 'ready' || catalogStatus === 'empty') {
      set({ catalogError: error })
      return
    }
    set({ catalogStatus: 'failed', catalogError: error })
  },
  /**
   * 写入读取到的已保存编排。来源事实另行合并，不覆盖卡片标题。
   *
   * `options.baseline` 用于装载时应用卡片间距兜底：草稿是规范化后的编排，基线仍是
   * 磁盘上的原编排，因此只产生“待保存”的 dirty，不会多出一条撤销记录；保存成功后
   * 再用 `markSaved` 把基线推进到规范化结果。
   */
  setArrangement: (arrangement, options) => {
    const draft = arrangementDraftOf(arrangement)
    const baselineDraft = options?.baseline ? arrangementDraftOf(options.baseline) : draft
    const dirty =
      options?.baseline !== undefined &&
      snapshotFingerprint(baselineDraft) !== snapshotFingerprint(draft)
    set({
      ...draft,
      selectedCardId: null,
      documentLayerCardId: null,
      arrangementStatus: draft.cards.length === 0 ? 'empty' : 'ready',
      arrangementError: null,
      baseline: cloneSnapshot(baselineDraft),
      past: [],
      future: [],
      saveState: dirty ? 'dirty' : 'saved',
      saveError: null,
      promptReferenceAlert: null,
      revision: 0,
      structuralRevision: 0,
      cardEditRevisions: {},
      layoutRevisions: {},
      viewportRevision: 0
    })
  },
  /** 没有已保存编排。空画布不是读取失败。 */
  setArrangementEmpty: () => {
    const draft: SessionSnapshot = {
      cards: [],
      relations: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    }
    set({
      ...draft,
      selectedCardId: null,
      documentLayerCardId: null,
      arrangementStatus: 'empty',
      arrangementError: null,
      baseline: cloneSnapshot(draft),
      past: [],
      future: [],
      saveState: 'idle',
      saveError: null,
      promptReferenceAlert: null,
      revision: 0,
      structuralRevision: 0,
      cardEditRevisions: {},
      layoutRevisions: {},
      viewportRevision: 0
    })
  },
  /**
   * 记录画布读取失败，不伪装为空画布。
   * @param error - 失败状态。
   */
  setArrangementFailure: (error) =>
    set({
      arrangementStatus: 'failed',
      arrangementError: error,
      cards: [],
      relations: [],
      selectedCardId: null,
      documentLayerCardId: null,
      baseline: null,
      past: [],
      future: [],
      saveState: 'idle',
      saveError: null,
      promptReferenceAlert: null
    }),
  /** 合并来源详情。卡片不复制正文，只在展示时查详情。 */
  putSourceDetails: (sources) => {
    const state = get()
    const sourceDetails = { ...state.sourceDetails }
    for (const source of sources) sourceDetails[source.sourceId] = source
    set({ sourceDetails })
  },
  setInspectionDiagnostics: (diagnostics) => set({ inspectionDiagnostics: diagnostics }),
  setPageBlocked: (blocked) => set({ pageBlocked: blocked }),
  selectCard: (cardId) => set({ selectedCardId: cardId }),
  openDocumentLayer: (cardId) => set({ documentLayerCardId: cardId, selectedCardId: cardId }),
  closeDocumentLayer: () => set({ documentLayerCardId: null }),
  /** 视口只用于恢复画布，不进入撤销栈。 */
  setViewport: (viewport) => {
    const state = get()
    if (
      state.viewport.x === viewport.x &&
      state.viewport.y === viewport.y &&
      state.viewport.zoom === viewport.zoom
    ) {
      return
    }
    const revision = state.revision + 1
    set({
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
      revision,
      viewportRevision: revision,
      saveState: dirtyStateOf(state)
    })
  },
  /** 一次提交多张卡片的新位置。位置未变则不记历史。 */
  moveCards: (moves) => {
    const state = get()
    if (moves.length === 0) return false
    const byId = new Map(moves.map((item) => [item.cardId, item]))
    const changed = state.cards.some((card) => {
      const move = byId.get(card.cardId)
      return move !== undefined && (card.layout.x !== move.x || card.layout.y !== move.y)
    })
    if (!changed) return false
    const revision = state.revision + 1
    const layoutRevisions = { ...state.layoutRevisions }
    const cards = state.cards.map((card) => {
      const move = byId.get(card.cardId)
      if (!move || (card.layout.x === move.x && card.layout.y === move.y)) return card
      layoutRevisions[card.cardId] = revision
      return { ...card, layout: { ...card.layout, x: move.x, y: move.y } }
    })
    set({
      cards,
      revision,
      layoutRevisions,
      past: pushPast(state, state.cards, state.relations),
      future: [],
      saveState: dirtyStateOf(state)
    })
    return true
  },
  resizeCard: (cardId, layout) => {
    const state = get()
    const card = state.cards.find((item) => item.cardId === cardId)
    if (!card || sameLayout(card.layout, layout)) return false
    const revision = state.revision + 1
    set({
      cards: state.cards.map((item) =>
        item.cardId === cardId ? { ...item, layout: { ...layout } } : item
      ),
      revision,
      layoutRevisions: { ...state.layoutRevisions, [cardId]: revision },
      past: pushPast(state, state.cards, state.relations),
      future: [],
      saveState: dirtyStateOf(state)
    })
    return true
  },
  /** 预览加载后的自动贴合。不单独记撤销，也不伪造用户缩放。 */
  applyFittedLayout: (cardId, layout) => {
    const state = get()
    const card = state.cards.find((item) => item.cardId === cardId)
    if (!card || sameLayout(card.layout, layout)) return false
    const revision = state.revision + 1
    set({
      cards: state.cards.map((item) =>
        item.cardId === cardId ? { ...item, layout: { ...layout } } : item
      ),
      revision,
      layoutRevisions: { ...state.layoutRevisions, [cardId]: revision },
      saveState: dirtyStateOf(state)
    })
    return true
  },
  /** 提示词正文先写本地草稿；请求合并与串行由命令层负责。 */
  setPromptBodyDraft: (cardId, body, recordHistory) => {
    const state = get()
    const card = state.cards.find((item) => item.cardId === cardId)
    if (!card || card.kind !== 'prompt' || card.body === body) return false
    const revision = state.revision + 1
    set({
      cards: state.cards.map((item) =>
        item.cardId === cardId && item.kind === 'prompt' ? { ...item, body } : item
      ),
      revision,
      cardEditRevisions: { ...state.cardEditRevisions, [cardId]: revision },
      past: recordHistory ? pushPast(state, state.cards, state.relations) : state.past,
      future: recordHistory ? [] : state.future,
      saveState: dirtyStateOf(state)
    })
    return true
  },
  /**
   * 提示词引用只存稳定 cardId。重复身份归一，同一引用集合不重复记历史。
   * 修改后由命令层立即保存整份编排；后端仍会按当前画布重新校验。
   */
  setPromptReferences: (cardId, referenceCardIds) => {
    const state = get()
    const card = state.cards.find((item) => item.cardId === cardId)
    if (!card || card.kind !== 'prompt') return false
    const current = promptReferenceIds(card.references)
    const next = [...new Set(referenceCardIds.filter((id) => id.length > 0))]
    if (current.length === next.length && current.every((id, index) => id === next[index])) {
      return false
    }
    const revision = state.revision + 1
    set({
      cards: state.cards.map((item) =>
        item.cardId === cardId && item.kind === 'prompt'
          ? { ...item, references: next.map((id) => ({ cardId: id })) }
          : item
      ),
      revision,
      cardEditRevisions: { ...state.cardEditRevisions, [cardId]: revision },
      past: pushPast(state, state.cards, state.relations),
      future: [],
      saveState: dirtyStateOf(state),
      promptReferenceAlert: null
    })
    return true
  },
  setPromptReferenceAlert: (alert) => set({ promptReferenceAlert: alert }),
  /**
   * 应用一次编辑响应。结构已在本请求之后变化时整份丢弃；
   * 局部内容或布局有更新时保留本地值，避免旧响应覆盖新编辑。
   */
  applyServerArrangement: (arrangement, capture) => {
    const state = get()
    if (capture.structuralRevision !== state.structuralRevision) return false
    const currentById = new Map(state.cards.map((card) => [card.cardId, card]))
    const nextCards = arrangement.cards.map((serverCard) => {
      const local = currentById.get(serverCard.cardId)
      if (!local) return cloneCard(serverCard)
      if ((state.cardEditRevisions[serverCard.cardId] ?? 0) > capture.revision) return local
      if ((state.layoutRevisions[serverCard.cardId] ?? 0) > capture.revision) {
        return mergeCardLayout(serverCard, local.layout)
      }
      return cloneCard(serverCard)
    })
    const nextRelations = arrangement.relations.map((relation) => ({ ...relation }))
    const viewport =
      state.viewportRevision > capture.revision
        ? { ...state.viewport }
        : { ...arrangement.viewport }
    const nextFingerprint = draftFingerprint(nextCards, nextRelations, viewport)
    const currentFingerprint = draftFingerprint(state.cards, state.relations, state.viewport)
    if (nextFingerprint === currentFingerprint) return true
    const structureChanged =
      structureKeyOf(nextCards, nextRelations) !== structureKeyOf(state.cards, state.relations)
    const cardIds = new Set(nextCards.map((card) => card.cardId))
    const addedCard = nextCards.find((card) => !currentById.has(card.cardId))
    const selectedCardId = addedCard
      ? addedCard.cardId
      : state.selectedCardId && cardIds.has(state.selectedCardId)
        ? state.selectedCardId
        : null
    const documentLayerCardId =
      state.documentLayerCardId &&
      nextCards.some(
        (card) => card.cardId === state.documentLayerCardId && card.kind === 'document'
      )
        ? state.documentLayerCardId
        : null
    set({
      cards: nextCards,
      relations: nextRelations,
      viewport,
      selectedCardId,
      documentLayerCardId,
      past: [...state.past, snapshotOf(state)].slice(-HISTORY_LIMIT),
      future: [],
      revision: state.revision,
      structuralRevision: structureChanged
        ? state.structuralRevision + 1
        : state.structuralRevision,
      cardEditRevisions: retainCardRevisions(state.cardEditRevisions, cardIds),
      layoutRevisions: retainCardRevisions(state.layoutRevisions, cardIds),
      saveState: resolveArrangementSaveState(state, nextFingerprint)
    })
    return true
  },
  markSaving: () => set({ saveState: 'saving', saveError: null }),
  /** 保存成功后以发送快照为基线；期间的新编辑仍记为未保存。 */
  markSaved: (sent) => {
    const state = get()
    const current = draftFingerprint(state.cards, state.relations, state.viewport)
    const saved = snapshotFingerprint(sent)
    set({
      baseline: cloneSnapshot(sent),
      saveState: current === saved ? 'saved' : 'dirty',
      saveError: null,
      promptReferenceAlert: null
    })
  },
  markSaveFailure: (saveState, error) => set({ saveState, saveError: error }),
  restoreSessionDraft: (snapshot) => {
    const state = get()
    const restored = cloneSnapshot(snapshot)
    const fingerprint = draftFingerprint(restored.cards, restored.relations, restored.viewport)
    const baseline = state.baseline
    const sameAsBaseline = baseline !== null && fingerprint === snapshotFingerprint(baseline)
    set({
      ...restored,
      selectedCardId: existingSelection(state, restored),
      documentLayerCardId: existingDocumentLayer(state, restored),
      past: [],
      future: [],
      revision: state.revision + 1,
      structuralRevision: state.structuralRevision + 1,
      saveState: sameAsBaseline
        ? baseline.cards.length === 0 && baseline.relations.length === 0
          ? 'idle'
          : 'saved'
        : 'dirty',
      saveError: null,
      promptReferenceAlert: null
    })
  },
  undo: () => {
    const state = get()
    const previous = state.past.at(-1)
    if (!previous) return
    const restored = cloneSnapshot(previous)
    set({
      ...restored,
      selectedCardId: existingSelection(state, restored),
      documentLayerCardId: existingDocumentLayer(state, restored),
      past: state.past.slice(0, -1),
      future: [snapshotOf(state), ...state.future].slice(0, HISTORY_LIMIT),
      revision: state.revision + 1,
      structuralRevision: state.structuralRevision + 1,
      saveState: resolveArrangementSaveState(
        state,
        draftFingerprint(restored.cards, restored.relations, restored.viewport)
      ),
      promptReferenceAlert: null
    })
  },
  redo: () => {
    const state = get()
    const next = state.future[0]
    if (!next) return
    const restored = cloneSnapshot(next)
    set({
      ...restored,
      selectedCardId: existingSelection(state, restored),
      documentLayerCardId: existingDocumentLayer(state, restored),
      past: [...state.past, snapshotOf(state)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      revision: state.revision + 1,
      structuralRevision: state.structuralRevision + 1,
      saveState: resolveArrangementSaveState(
        state,
        draftFingerprint(restored.cards, restored.relations, restored.viewport)
      ),
      promptReferenceAlert: null
    })
  }
}))

/** 当前会话是否有尚未确认保持的改动。 */
export function sessionIsDirty(
  state: Pick<Store, 'cards' | 'relations' | 'viewport' | 'baseline'>
): boolean {
  if (!state.baseline) return state.cards.length > 0 || state.relations.length > 0
  return (
    draftFingerprint(state.cards, state.relations, state.viewport) !==
    snapshotFingerprint(state.baseline)
  )
}

function dirtyStateOf(state: WorkbenchSessionState): WorkbenchSaveState {
  if (
    state.saveState === 'saving' ||
    state.saveState === 'unverified' ||
    state.saveState === 'unsaved' ||
    state.saveState === 'committedUnsubmitted' ||
    state.saveState === 'failed'
  ) {
    return state.saveState
  }
  return 'dirty'
}

function resolveArrangementSaveState(
  state: WorkbenchSessionState,
  fingerprint: string
): WorkbenchSaveState {
  if (state.saveState === 'saving') return 'saving'
  if (state.saveState === 'unverified') return 'unverified'
  if (
    state.saveState === 'unsaved' ||
    state.saveState === 'committedUnsubmitted' ||
    state.saveState === 'failed'
  ) {
    return state.saveState
  }
  if (state.baseline && fingerprint === snapshotFingerprint(state.baseline)) {
    return state.baseline.cards.length === 0 && state.baseline.relations.length === 0
      ? 'idle'
      : 'saved'
  }
  return 'dirty'
}

function pushPast(
  state: WorkbenchSessionState,
  cards: readonly SceneCanvasCardVO[],
  relations: WorkbenchSessionState['relations']
): SessionSnapshot[] {
  return [...state.past, snapshotOf({ cards, relations, viewport: state.viewport })].slice(
    -HISTORY_LIMIT
  )
}

function sameLayout(left: SessionCardLayout, right: SessionCardLayout): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function mergeCardLayout(card: SceneCanvasCardVO, layout: SessionCardLayout): SceneCanvasCardVO {
  return { ...card, layout: { ...layout } } as SceneCanvasCardVO
}

function structureKeyOf(
  cards: readonly SceneCanvasCardVO[],
  relations: WorkbenchSessionState['relations']
): string {
  return JSON.stringify({
    cards: cards.map((card) => [card.cardId, card.kind]),
    relations: relations.map((relation) => [
      relation.relationId,
      relation.fromCardId,
      relation.toCardId
    ])
  })
}

function retainCardRevisions(
  revisions: Readonly<Record<string, number>>,
  cardIds: ReadonlySet<string>
): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [cardId, revision] of Object.entries(revisions)) {
    if (cardIds.has(cardId)) next[cardId] = revision
  }
  return next
}

function existingSelection(state: WorkbenchSessionState, snapshot: SessionSnapshot): string | null {
  return state.selectedCardId && snapshot.cards.some((card) => card.cardId === state.selectedCardId)
    ? state.selectedCardId
    : null
}

function existingDocumentLayer(
  state: WorkbenchSessionState,
  snapshot: SessionSnapshot
): string | null {
  return state.documentLayerCardId &&
    snapshot.cards.some(
      (card) => card.cardId === state.documentLayerCardId && card.kind === 'document'
    )
    ? state.documentLayerCardId
    : null
}
