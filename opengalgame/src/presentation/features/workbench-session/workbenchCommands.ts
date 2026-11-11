import { toast } from 'sonner'

import type { SceneCanvasSaveReason } from '@application/scene-canvas/dto/SceneCanvasDTO'
import type {
  SceneCanvasArrangementVO,
  SceneCanvasWebgalPresetVO
} from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { findFreeCanvasPosition } from '../scene-canvas/canvasPlacement'
import {
  PROJECT_WORKSPACE_NOT_READY_CODE,
  workbenchFeedback
} from '../../feedback/workbenchFeedback'
import { defaultCardSize } from './contentKindLabel'
import {
  appendPromptReferenceId,
  promptReferenceFailureOf,
  removePromptReferenceIds
} from './promptReferences'
import {
  draftArrangementOf,
  layoutAt,
  layoutForNaturalPreview,
  snapshotOf
} from './workbenchSessionMapper'
import { sessionIsDirty, useWorkbenchSessionStore } from './workbenchSession.store'
import { sourceFactsOf, type SourceFactsView } from './workbenchSessionSelectors'
import type {
  SessionCard,
  SessionCardLayout,
  SessionViewport,
  WorkbenchSaveState
} from './workbenchSession.types'
import type { SessionFieldKind } from './webgalPreset'

const PROMPT_FLUSH_DELAY_MS = 450
const AUTO_SAVE_DELAY_MS = 30_000

export type CreateSourceCardResult = 'created' | 'missing' | 'unreadable' | 'failed'

/** 已应用、被会话切换或撤销作废、以及请求本身失败。作废不是新的失败。 */
export type ArrangementEditResult = 'applied' | 'dropped' | 'failed'

export interface WorkbenchCommands {
  createSourceCard(
    sourceId: string,
    position: { x: number; y: number }
  ): Promise<CreateSourceCardResult>
  createPromptCard(position: { x: number; y: number }): Promise<string | null>
  createFieldCard(
    kind: SessionFieldKind,
    position: { x: number; y: number }
  ): Promise<string | null>
  editCard(
    cardId: string,
    input: { title?: string; summary?: string }
  ): Promise<ArrangementEditResult>
  editPromptBody(cardId: string, body: string): void
  /** 追加一个稳定 cardId 引用，并立即保存整份编排。 */
  addPromptReference(cardId: string, referenceCardId: string): void
  /** 移除一个或多个引用身份；失效引用也用同一入口清理。 */
  removePromptReferences(cardId: string, referenceCardIds: readonly string[]): void
  flushPromptEdits(): Promise<void>
  bindFieldCardPreset(
    cardId: string,
    preset: SceneCanvasWebgalPresetVO | null
  ): Promise<ArrangementEditResult>
  copyCard(cardId: string): Promise<ArrangementEditResult>
  deleteCard(cardId: string): Promise<ArrangementEditResult>
  connectCards(fromCardId: string, toCardId: string): Promise<ArrangementEditResult>
  disconnectCards(relationId: string): Promise<ArrangementEditResult>
  editRelationName(relationId: string, specificName: string): Promise<ArrangementEditResult>
  attachRelationRecord(relationId: string, recordCardId: string): Promise<ArrangementEditResult>
  detachRelationRecord(relationId: string): Promise<ArrangementEditResult>
  save(reason?: SceneCanvasSaveReason): Promise<void>
  /** 历史写操作前停止自动保存和延迟编辑，并等待已在途请求结算。 */
  prepareHistoryWrite(): Promise<void>
  /** 撤销后视图无法重新读取时暂停保存，直到重新读取成功。 */
  setSaveHold(hold: boolean): void
  undo(): void
  redo(): void
  moveCards(moves: readonly { cardId: string; x: number; y: number }[]): void
  resizeCard(cardId: string, layout: SessionCardLayout): void
  fitPreviewAspect(cardId: string, naturalWidth: number, naturalHeight: number): void
  setViewport(viewport: SessionViewport): void
  selectCard(cardId: string | null): void
  openDocumentLayer(cardId: string): void
  closeDocumentLayer(): void
  dispose(): void
}

/**
 * 会话命令。所有编辑请求串行执行，保存与自动保存排程也在这里，
 * 组件只调用命令，不直接创建客户端或排程保存。
 */
export function createWorkbenchCommands(client: SceneCanvasClient): WorkbenchCommands {
  const store = useWorkbenchSessionStore
  let queue: Promise<unknown> = Promise.resolve()
  const pendingPromptCards = new Set<string>()
  const promptBursts = new Set<string>()
  let promptTimer: ReturnType<typeof setTimeout> | null = null
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
  let queuedSave: Promise<void> | null = null
  let pendingSaveReason: SceneCanvasSaveReason = 'periodic'
  let manualSaveRequested = false
  let autoSaveStopped: 'none' | 'failed' | 'unverified' = 'none'
  let saveHold = false

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  function clearPromptTimer(): void {
    if (promptTimer !== null) {
      clearTimeout(promptTimer)
      promptTimer = null
    }
  }

  function clearAutoSaveTimer(): void {
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
  }

  function schedulePromptFlush(): void {
    if (promptTimer !== null) return
    promptTimer = setTimeout(() => {
      promptTimer = null
      void flushPromptEdits()
    }, PROMPT_FLUSH_DELAY_MS)
  }

  function noteLocalEdit(): void {
    if (autoSaveStopped === 'unverified' || saveHold) return
    autoSaveStopped = 'none'
    scheduleAutoSave()
  }

  function noteServerResult(): void {
    if (autoSaveStopped !== 'none' || saveHold) return
    scheduleAutoSave()
  }

  function scheduleAutoSave(): void {
    if (saveHold || autoSaveTimer !== null || queuedSave !== null) return
    if (autoSaveStopped === 'unverified') return
    const state = store.getState()
    if (state.arrangementStatus !== 'ready' && state.arrangementStatus !== 'empty') return
    if (!sessionIsDirty(state)) return
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null
      void requestSave('periodic')
    }, AUTO_SAVE_DELAY_MS)
  }

  async function flushPromptEdits(): Promise<void> {
    clearPromptTimer()
    if (pendingPromptCards.size === 0) return
    const cards = [...pendingPromptCards]
    pendingPromptCards.clear()
    let chain: Promise<void> = Promise.resolve()
    for (const cardId of cards) {
      chain = chain.then(() => sendPromptEdit(cardId))
    }
    await chain
  }

  function sendPromptEdit(cardId: string): Promise<void> {
    return enqueue(async () => {
      const state = store.getState()
      const card = state.cards.find((item) => item.cardId === cardId)
      if (!card || card.kind !== 'prompt') return
      const capture = {
        revision: state.revision,
        structuralRevision: state.structuralRevision
      }
      try {
        const arrangement = requireSuccess(
          await client.editPromptBody({
            projectId: state.projectId,
            sceneId: state.sceneId,
            canvasId: state.canvasId,
            arrangement: draftArrangementOf(state),
            cardId,
            body: card.body
          })
        )
        if (store.getState().projectId !== state.projectId) return
        store.getState().applyServerArrangement(arrangement, capture)
        const current = store.getState()
        if ((current.cardEditRevisions[cardId] ?? 0) <= capture.revision) {
          promptBursts.delete(cardId)
        }
        noteServerResult()
      } catch (error) {
        const failure = failureOf(error)
        const referenceFailure = promptReferenceFailureOf(failure)
        if (referenceFailure) {
          store.getState().setPromptReferenceAlert({ message: referenceFailure.text, cardId })
        }
        toast(referenceFailure?.text ?? failure.msg)
      }
    })
  }

  function edit(
    build: (arrangement: SceneCanvasArrangementVO) => Promise<AjaxResult<SceneCanvasArrangementVO>>,
    options?: { silentFailure?: boolean }
  ): Promise<ArrangementEditResult> {
    return enqueue(async () => {
      const state = store.getState()
      const capture = {
        revision: state.revision,
        structuralRevision: state.structuralRevision
      }
      try {
        const arrangement = requireSuccess(await build(draftArrangementOf(state)))
        if (store.getState().projectId !== state.projectId) return 'dropped'
        const applied = store.getState().applyServerArrangement(arrangement, capture)
        if (!applied) return 'dropped'
        noteServerResult()
        return 'applied'
      } catch (error) {
        if (!options?.silentFailure) toast(failureOf(error).msg)
        return 'failed'
      }
    })
  }

  async function beforeEdit(): Promise<void> {
    await flushPromptEdits()
  }

  function runSave(reason: SceneCanvasSaveReason): Promise<void> {
    if (queuedSave !== null) {
      if (reason === 'manual') manualSaveRequested = true
      return queuedSave
    }
    pendingSaveReason = reason
    const run = enqueue(async () => {
      const effectiveReason = manualSaveRequested ? 'manual' : pendingSaveReason
      manualSaveRequested = false
      await performSave(effectiveReason)
    })
    queuedSave = run
    void run.finally(() => {
      if (queuedSave === run) queuedSave = null
      if (manualSaveRequested) {
        manualSaveRequested = false
        void requestSave('manual')
        return
      }
      if (autoSaveStopped === 'none' && sessionIsDirty(store.getState())) scheduleAutoSave()
    })
    return run
  }

  function requestSave(reason: SceneCanvasSaveReason): Promise<void> {
    if (saveHold) return Promise.resolve()
    clearAutoSaveTimer()
    if (reason === 'manual') manualSaveRequested = true
    return beforeEdit().then(() => runSave(reason))
  }

  async function prepareHistoryWrite(): Promise<void> {
    clearPromptTimer()
    clearAutoSaveTimer()
    pendingPromptCards.clear()
    promptBursts.clear()
    await queue
  }

  function setSaveHold(hold: boolean): void {
    saveHold = hold
    if (hold) {
      clearAutoSaveTimer()
      return
    }
    if (autoSaveStopped === 'none' && sessionIsDirty(store.getState())) scheduleAutoSave()
  }

  async function performSave(reason: SceneCanvasSaveReason): Promise<void> {
    const state = store.getState()
    if (!sessionIsDirty(state) && (state.saveState === 'saved' || state.saveState === 'idle')) {
      if (reason === 'manual') toast(workbenchFeedback.saveNoChanges)
      return
    }
    if (state.arrangementStatus !== 'ready' && state.arrangementStatus !== 'empty') return
    const sent = snapshotOf(state)
    state.markSaving()
    try {
      requireSuccess(
        await client.saveSceneCanvasArrangement({
          projectId: state.projectId,
          sceneId: state.sceneId,
          canvasId: state.canvasId,
          reason,
          arrangement: draftArrangementOf(state)
        })
      )
      if (store.getState().projectId !== state.projectId) return
      store.getState().markSaved(sent)
      autoSaveStopped = 'none'
      if (sessionIsDirty(store.getState())) scheduleAutoSave()
      if (reason === 'manual') toast(workbenchFeedback.saveSucceeded)
    } catch (error) {
      if (store.getState().projectId !== state.projectId) return
      const failure = failureOf(error)
      const safe =
        failure.code === PROJECT_WORKSPACE_NOT_READY_CODE
          ? { code: failure.code, msg: '工程初始化未完成，请重新构建' }
          : failure
      const saveState = saveStateOfCode(safe.code)
      store.getState().markSaveFailure(saveState, safe)
      const referenceFailure = promptReferenceFailureOf(safe)
      if (referenceFailure) {
        store.getState().setPromptReferenceAlert({ message: referenceFailure.text })
      }
      autoSaveStopped = saveState === 'unverified' ? 'unverified' : 'failed'
      toast(
        referenceFailure
          ? `${workbenchFeedback.saveFailed}（${referenceFailure.text}）`
          : saveFailureText(saveState, safe.msg)
      )
    }
  }

  async function createSourceCard(
    sourceId: string,
    position: { x: number; y: number }
  ): Promise<CreateSourceCardResult> {
    const facts = sourceFactsOf(store.getState(), sourceId)
    if (!facts.summary) return 'missing'
    if (!facts.readable) return 'unreadable'
    const kind = sourceKindOf(facts)
    if (!kind) return 'unreadable'
    await beforeEdit()
    const created = await edit((arrangement) =>
      client.createSourceCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        sourceId,
        layout: layoutAt(kind, position.x, position.y)
      })
    )
    return created === 'applied' ? 'created' : 'failed'
  }

  async function createCardOfKind(
    kind: SessionFieldKind,
    position: { x: number; y: number }
  ): Promise<string | null> {
    await beforeEdit()
    const beforeIds = new Set(store.getState().cards.map((card) => card.cardId))
    const created = await edit((arrangement) =>
      client.createFieldCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        kind,
        layout: layoutAt(kind, position.x, position.y)
      })
    )
    if (created !== 'applied') return null
    return store.getState().cards.find((card) => !beforeIds.has(card.cardId))?.cardId ?? null
  }

  async function createPromptCard(position: { x: number; y: number }): Promise<string | null> {
    await beforeEdit()
    const beforeIds = new Set(store.getState().cards.map((card) => card.cardId))
    const created = await edit((arrangement) =>
      client.createPromptCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        layout: layoutAt('prompt', position.x, position.y)
      })
    )
    if (created !== 'applied') return null
    return store.getState().cards.find((card) => !beforeIds.has(card.cardId))?.cardId ?? null
  }

  async function editCard(
    cardId: string,
    input: { title?: string; summary?: string }
  ): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.editCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        cardId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary })
      })
    )
  }

  function editPromptBody(cardId: string, body: string): void {
    const first = !promptBursts.has(cardId)
    if (!store.getState().setPromptBodyDraft(cardId, body, first)) return
    promptBursts.add(cardId)
    pendingPromptCards.add(cardId)
    schedulePromptFlush()
    noteLocalEdit()
  }

  /** 引用身份用整份编排保存，不拼进正文，也不复用只写 body 的局部请求。 */
  function persistPromptReferences(cardId: string, referenceCardIds: readonly string[]): void {
    if (!store.getState().setPromptReferences(cardId, referenceCardIds)) return
    noteLocalEdit()
    void requestSave('periodic')
  }

  function addPromptReference(cardId: string, referenceCardId: string): void {
    const state = store.getState()
    const card = state.cards.find((item) => item.cardId === cardId)
    const target = state.cards.find((item) => item.cardId === referenceCardId)
    if (!card || card.kind !== 'prompt' || !target) return
    if (target.cardId === cardId || target.kind === 'prompt') return
    persistPromptReferences(cardId, appendPromptReferenceId(card.references, referenceCardId))
  }

  function removePromptReferences(cardId: string, referenceCardIds: readonly string[]): void {
    const card = store.getState().cards.find((item) => item.cardId === cardId)
    if (!card || card.kind !== 'prompt') return
    persistPromptReferences(cardId, removePromptReferenceIds(card.references, referenceCardIds))
  }

  async function bindFieldCardPreset(
    cardId: string,
    preset: SceneCanvasWebgalPresetVO | null
  ): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit(
      (arrangement) =>
        client.bindFieldCardPreset({
          projectId: store.getState().projectId,
          sceneId: store.getState().sceneId,
          canvasId: store.getState().canvasId,
          arrangement,
          cardId,
          preset
        }),
      // 预设卡与编辑弹窗都在原地显示具体错误，避免同一失败再顶一条通用 Toast。
      { silentFailure: true }
    )
  }

  async function copyCard(cardId: string): Promise<ArrangementEditResult> {
    const state = store.getState()
    const card = state.cards.find((item) => item.cardId === cardId)
    if (!card) return 'failed'
    const size = defaultCardSize(card.kind)
    const width = card.layout.width || size.width
    const height = card.layout.height || size.height
    // 复用画布放置的保空逻辑，避免副本与源卡或相邻卡重叠。
    const { position } = findFreeCanvasPosition(
      state.cards,
      { x: card.layout.x + 32, y: card.layout.y + 32 },
      { width, height }
    )
    const layout: SessionCardLayout = { x: position.x, y: position.y, width, height }
    await beforeEdit()
    return edit((arrangement) =>
      client.copyCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        cardId,
        layout
      })
    )
  }

  async function deleteCard(cardId: string): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.deleteCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        cardId
      })
    )
  }

  async function connectCards(
    fromCardId: string,
    toCardId: string
  ): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.connectCards({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        fromCardId,
        toCardId
      })
    )
  }

  async function disconnectCards(relationId: string): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.disconnectCards({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        relationId
      })
    )
  }

  async function editRelationName(
    relationId: string,
    specificName: string
  ): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.editRelationName({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        relationId,
        specificName
      })
    )
  }

  async function attachRelationRecord(
    relationId: string,
    recordCardId: string
  ): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.attachRelationRecord({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        relationId,
        recordCardId
      })
    )
  }

  async function detachRelationRecord(relationId: string): Promise<ArrangementEditResult> {
    await beforeEdit()
    return edit((arrangement) =>
      client.detachRelationRecord({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        relationId
      })
    )
  }

  function undo(): void {
    clearPromptTimer()
    pendingPromptCards.clear()
    promptBursts.clear()
    store.getState().undo()
    if (sessionIsDirty(store.getState())) noteLocalEdit()
  }

  function redo(): void {
    clearPromptTimer()
    pendingPromptCards.clear()
    promptBursts.clear()
    store.getState().redo()
    if (sessionIsDirty(store.getState())) noteLocalEdit()
  }

  return {
    createSourceCard,
    createPromptCard,
    createFieldCard: createCardOfKind,
    editCard,
    editPromptBody,
    addPromptReference,
    removePromptReferences,
    flushPromptEdits,
    bindFieldCardPreset,
    copyCard,
    deleteCard,
    connectCards,
    disconnectCards,
    editRelationName,
    attachRelationRecord,
    detachRelationRecord,
    save: (reason = 'manual') => requestSave(reason),
    prepareHistoryWrite,
    setSaveHold,
    undo,
    redo,
    moveCards: (moves) => {
      if (store.getState().moveCards(moves)) noteLocalEdit()
    },
    resizeCard: (cardId, layout) => {
      if (store.getState().resizeCard(cardId, layout)) noteLocalEdit()
    },
    fitPreviewAspect: (cardId, naturalWidth, naturalHeight) => {
      if (naturalWidth <= 0 || naturalHeight <= 0) return
      const state = store.getState()
      const card = state.cards.find((item) => item.cardId === cardId)
      if (!card) return
      const layout = layoutForNaturalPreview(card.layout, naturalWidth, naturalHeight)
      if (state.applyFittedLayout(cardId, layout)) noteLocalEdit()
    },
    setViewport: (viewport) => {
      store.getState().setViewport(viewport)
      if (sessionIsDirty(store.getState())) noteLocalEdit()
    },
    selectCard: (cardId) => store.getState().selectCard(cardId),
    openDocumentLayer: (cardId) => {
      const card = store.getState().cards.find((item) => item.cardId === cardId)
      if (card?.kind !== 'document') return
      store.getState().openDocumentLayer(cardId)
    },
    closeDocumentLayer: () => store.getState().closeDocumentLayer(),
    dispose: () => {
      clearPromptTimer()
      clearAutoSaveTimer()
      pendingPromptCards.clear()
      promptBursts.clear()
    }
  }
}

let activeCommands: WorkbenchCommands | null = null

/** 页面装配时登记命令。非 React 代码通过它调用同一实例。 */
export function setActiveWorkbenchCommands(commands: WorkbenchCommands | null): void {
  activeCommands = commands
}

export function getActiveWorkbenchCommands(): WorkbenchCommands | null {
  return activeCommands
}

function sourceKindOf(facts: SourceFactsView): SessionCard['kind'] | null {
  const contentKind = facts.summary?.contentKind ?? facts.detail?.contentKind
  if (!contentKind) return null
  return contentKind === 'text' ? 'document' : contentKind
}

/** 保存失败码到界面状态；装载时的间距兜底保存也复用同一映射。 */
export function saveStateOfCode(code: number): WorkbenchSaveState {
  if (code === 4411) return 'unsaved'
  if (code === 4412) return 'committedUnsubmitted'
  if (code === 4413 || code === ErrorCodes.communicationFailed) return 'unverified'
  return 'failed'
}

/** 保存失败文案；与 `saveStateOfCode` 一起供装载路径复用。 */
export function saveFailureText(state: WorkbenchSaveState, message: string): string {
  if (state === 'unsaved') return workbenchFeedback.saveUnsaved
  if (state === 'committedUnsubmitted') return workbenchFeedback.saveCommittedUnsubmitted
  if (state === 'unverified') return workbenchFeedback.saveUnverified
  return `${workbenchFeedback.saveFailed}（${message}）`
}

/** 供测试和页面判断错误码归属，不按消息文本猜测。 */
export const SAVE_ERROR_CODES = {
  persistFailed: 4411,
  commitFailed: 4412,
  commitUnknown: 4413
} as const
