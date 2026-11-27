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
  createWorkbenchAutoSave,
  type WorkbenchSaveRequestOptions
} from './workbenchAutoSave'
import { createWorkbenchCommandQueue } from './workbenchCommandQueue'
import type {
  RelationAction,
  WorkbenchActionObservers,
  WorkbenchActionScope
} from './workbenchActionObservers'
import { createWorkbenchPromptEdits } from './workbenchPromptEdits'
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
  SessionRelation,
  SessionViewport,
  WorkbenchSaveState
} from './workbenchSession.types'
import type { SessionFieldKind } from './webgalPreset'

export type CreateSourceCardResult = 'created' | 'missing' | 'unreadable' | 'failed'

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
  addPromptReference(cardId: string, referenceCardId: string): void
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
  save(
    reason?: SceneCanvasSaveReason,
    options?: WorkbenchSaveRequestOptions
  ): Promise<void>
  prepareHistoryWrite(): Promise<void>
  setSaveHold(hold: boolean): void
  undo(): void
  redo(): void
  moveCards(moves: readonly { cardId: string; x: number; y: number }[]): void
  resizeCard(cardId: string, layout: SessionCardLayout): void
  fitPreviewAspect(cardId: string, naturalWidth: number, naturalHeight: number): void
  setViewport(viewport: SessionViewport): void
  selectCard(cardId: string | null): void
  openDocumentLayer(cardId: string): void
  /** 文档层当前卡片已有可显示正文时由文档层上报阅读事实；打开本身不算。 */
  reportDocumentBodyReady(cardId: string): void
  closeDocumentLayer(): void
  dispose(): void
}

export function createWorkbenchCommands(
  client: SceneCanvasClient,
  observers: WorkbenchActionObservers = {}
): WorkbenchCommands {
  const store = useWorkbenchSessionStore
  const queue = createWorkbenchCommandQueue()
  const promptEdits = createWorkbenchPromptEdits({
    client,
    enqueue: queue.enqueue,
    noteLocalEdit,
    noteServerResult,
    onSaved: (cardId, scope) => {
      observers.onPromptBodySaved?.({ scope, cardId })
    }
  })
  const autoSave = createWorkbenchAutoSave({
    enqueue: queue.enqueue,
    flushPromptEdits: promptEdits.flush,
    performSave
  })

  function noteLocalEdit(): void {
    autoSave.noteLocalEdit()
  }

  function noteServerResult(): void {
    autoSave.noteServerResult()
  }

  /** 捕获动作发生时的会话作用域；命令在 await 期间切走时由观察源按当前快照丢弃。 */
  function currentScope(): WorkbenchActionScope | null {
    const state = store.getState()
    if (
      state.projectId.length === 0 ||
      state.sceneId.length === 0 ||
      state.canvasId.length === 0
    ) {
      return null
    }
    return {
      projectId: state.projectId,
      sceneId: state.sceneId,
      canvasId: state.canvasId
    }
  }

  function reportCardCreated(scope: WorkbenchActionScope | null, card: SessionCard): void {
    if (!scope) return
    observers.onCardCreated?.({
      scope,
      cardId: card.cardId,
      cardKind: card.kind
    })
  }

  /** 连线两端带稳定的卡片身份和类别；缺任一端就不上报，避免把半条线当完成。 */
  function relationActionOf(
    scope: WorkbenchActionScope,
    relation: SessionRelation
  ): RelationAction | null {
    const cards = store.getState().cards
    const from = cards.find((card) => card.cardId === relation.fromCardId)
    const to = cards.find((card) => card.cardId === relation.toCardId)
    if (!from || !to) return null
    return {
      scope,
      relationId: relation.relationId,
      fromCardId: from.cardId,
      toCardId: to.cardId,
      fromCardKind: from.kind,
      toCardKind: to.kind
    }
  }

  function edit(
    build: (arrangement: SceneCanvasArrangementVO) => Promise<AjaxResult<SceneCanvasArrangementVO>>,
    options?: { silentFailure?: boolean }
  ): Promise<ArrangementEditResult> {
    return queue.enqueue(async () => {
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
    await promptEdits.flush()
  }

  async function prepareHistoryWrite(): Promise<void> {
    promptEdits.discardPending()
    autoSave.cancelScheduledSave()
    await queue.idle()
  }

  async function performSave(
    reason: SceneCanvasSaveReason,
    reportGuide = true
  ): Promise<void> {
    const state = store.getState()
    const scope = currentScope()
    if (!sessionIsDirty(state) && (state.saveState === 'saved' || state.saveState === 'idle')) {
      if (reason === 'manual') {
        toast(workbenchFeedback.saveNoChanges)
        // 手动保存请求且没有需要保存的改动，同样视为用户完成了一次手动保存。
        if (reportGuide && scope) observers.onCanvasSaved?.({ scope })
      }
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
      autoSave.noteSaved()
      if (reason === 'manual') {
        toast(workbenchFeedback.saveSucceeded)
        if (reportGuide && scope) observers.onCanvasSaved?.({ scope })
      }
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
      autoSave.noteSaveFailure(saveState)
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
    const scope = currentScope()
    const beforeIds = new Set(store.getState().cards.map((card) => card.cardId))
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
    if (created !== 'applied') return 'failed'
    const card = store.getState().cards.find((item) => !beforeIds.has(item.cardId))
    if (card) reportCardCreated(scope, card)
    return 'created'
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
    const scope = currentScope()
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
    const card = store.getState().cards.find((item) => !beforeIds.has(item.cardId))
    if (card) reportCardCreated(scope, card)
    return card?.cardId ?? null
  }

  async function editCard(
    cardId: string,
    input: { title?: string; summary?: string }
  ): Promise<ArrangementEditResult> {
    const scope = currentScope()
    await beforeEdit()
    // 起始用途取自本次提交的草稿，和确认后的用途比较，避免把只改标题或
    // 原样重存当成写了用途；用途正文不进入通知。
    let purposeBefore: string | null = null
    const result = await edit((arrangement) => {
      const before = arrangement.cards.find((item) => item.cardId === cardId)
      purposeBefore =
        before &&
        (before.kind === 'image' || before.kind === 'audio' || before.kind === 'video')
          ? before.summary.trim()
          : null
      return client.editCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        cardId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary })
      })
    })
    if (result === 'applied' && scope) {
      const applied = store.getState().cards.find((item) => item.cardId === cardId)
      if (
        input.summary !== undefined &&
        applied &&
        purposeBefore !== null &&
        (applied.kind === 'image' || applied.kind === 'audio' || applied.kind === 'video') &&
        applied.summary.trim().length > 0 &&
        applied.summary.trim() !== purposeBefore
      ) {
        observers.onCardEdited?.({ scope, cardId, cardKind: applied.kind })
      }
    }
    return result
  }

  function editPromptBody(cardId: string, body: string): void {
    promptEdits.editPromptBody(cardId, body)
  }

  function persistPromptReferences(cardId: string, referenceCardIds: readonly string[]): void {
    if (!store.getState().setPromptReferences(cardId, referenceCardIds)) return
    noteLocalEdit()
    void autoSave.requestSave('periodic')
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
    const scope = currentScope()
    const card = store.getState().cards.find((item) => item.cardId === cardId)
    await beforeEdit()
    const result = await edit((arrangement) =>
      client.deleteCard({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        cardId
      })
    )
    if (result === 'applied' && scope && card) {
      observers.onCardDeleted?.({
        scope,
        cardId: card.cardId,
        cardKind: card.kind
      })
    }
    return result
  }

  async function connectCards(
    fromCardId: string,
    toCardId: string
  ): Promise<ArrangementEditResult> {
    const scope = currentScope()
    const beforeIds = new Set(
      store.getState().relations.map((relation) => relation.relationId)
    )
    await beforeEdit()
    const result = await edit((arrangement) =>
      client.connectCards({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        fromCardId,
        toCardId
      })
    )
    if (result === 'applied' && scope) {
      const relation = store
        .getState()
        .relations.find((item) => !beforeIds.has(item.relationId))
      const action = relation ? relationActionOf(scope, relation) : null
      if (action) observers.onRelationCreated?.(action)
    }
    return result
  }

  async function disconnectCards(relationId: string): Promise<ArrangementEditResult> {
    const scope = currentScope()
    const relation = store.getState().relations.find((item) => item.relationId === relationId)
    const action = scope && relation ? relationActionOf(scope, relation) : null
    await beforeEdit()
    const result = await edit((arrangement) =>
      client.disconnectCards({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        relationId
      })
    )
    if (result === 'applied' && action) {
      observers.onRelationDeleted?.(action)
    }
    return result
  }

  async function editRelationName(
    relationId: string,
    specificName: string
  ): Promise<ArrangementEditResult> {
    const scope = currentScope()
    await beforeEdit()
    const result = await edit((arrangement) =>
      client.editRelationName({
        projectId: store.getState().projectId,
        sceneId: store.getState().sceneId,
        canvasId: store.getState().canvasId,
        arrangement,
        relationId,
        specificName
      })
    )
    if (result === 'applied' && scope) {
      const relation = store
        .getState()
        .relations.find((item) => item.relationId === relationId)
      const action = relation ? relationActionOf(scope, relation) : null
      if (action) observers.onRelationNamed?.(action)
    }
    return result
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
    promptEdits.discardPending()
    store.getState().undo()
    if (sessionIsDirty(store.getState())) noteLocalEdit()
  }

  function redo(): void {
    promptEdits.discardPending()
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
    flushPromptEdits: promptEdits.flush,
    bindFieldCardPreset,
    copyCard,
    deleteCard,
    connectCards,
    disconnectCards,
    editRelationName,
    attachRelationRecord,
    detachRelationRecord,
    save: (reason = 'manual', options) => autoSave.requestSave(reason, options),
    prepareHistoryWrite,
    setSaveHold: (hold) => autoSave.setSaveHold(hold),
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
    selectCard: (cardId) => {
      store.getState().selectCard(cardId)
      if (!cardId) return
      const card = store.getState().cards.find((item) => item.cardId === cardId)
      const scope = currentScope()
      if (!card || !scope) return
      observers.onCardSelected?.({
        scope,
        cardId,
        cardKind: card.kind
      })
    },
    openDocumentLayer: (cardId) => {
      const card = store.getState().cards.find((item) => item.cardId === cardId)
      if (card?.kind !== 'document') return
      store.getState().openDocumentLayer(cardId)
    },
    reportDocumentBodyReady: (cardId) => {
      const state = store.getState()
      // 只认当前打开且仍是文档卡的这一层；关闭、切卡或切工程后的迟到读取
      // 不再发布阅读事实。
      if (state.documentLayerCardId !== cardId) return
      const card = state.cards.find((item) => item.cardId === cardId)
      if (card?.kind !== 'document') return
      const scope = currentScope()
      if (scope) observers.onDocumentOpened?.({ scope, cardId })
    },
    closeDocumentLayer: () => {
      const state = store.getState()
      const cardId = state.documentLayerCardId
      if (!cardId) return
      const card = state.cards.find((item) => item.cardId === cardId)
      const scope = currentScope()
      store.getState().closeDocumentLayer()
      if (card?.kind !== 'document' || !scope) return
      // 只有真正关闭文档层才发布「回到画布」；取消未保存确认时不会调用这里。
      observers.onDocumentClosed?.({ scope, cardId })
    },
    dispose: () => {
      promptEdits.dispose()
      autoSave.cancelScheduledSave()
    }
  }
}

let activeCommands: WorkbenchCommands | null = null

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

export function saveStateOfCode(code: number): WorkbenchSaveState {
  if (code === 4411) return 'unsaved'
  if (code === 4412) return 'committedUnsubmitted'
  if (code === 4413 || code === ErrorCodes.communicationFailed) return 'unverified'
  return 'failed'
}

export function saveFailureText(state: WorkbenchSaveState, message: string): string {
  if (state === 'unsaved') return workbenchFeedback.saveUnsaved
  if (state === 'committedUnsubmitted') return workbenchFeedback.saveCommittedUnsubmitted
  if (state === 'unverified') return workbenchFeedback.saveUnverified
  return `${workbenchFeedback.saveFailed}（${message}）`
}
