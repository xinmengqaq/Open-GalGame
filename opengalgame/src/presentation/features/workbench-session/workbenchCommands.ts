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
import { createWorkbenchAutoSave } from './workbenchAutoSave'
import { createWorkbenchCommandQueue } from './workbenchCommandQueue'
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
  save(reason?: SceneCanvasSaveReason): Promise<void>
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
  closeDocumentLayer(): void
  dispose(): void
}

export function createWorkbenchCommands(client: SceneCanvasClient): WorkbenchCommands {
  const store = useWorkbenchSessionStore
  const queue = createWorkbenchCommandQueue()
  const promptEdits = createWorkbenchPromptEdits({
    client,
    enqueue: queue.enqueue,
    noteLocalEdit,
    noteServerResult
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
      autoSave.noteSaved()
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
    save: (reason = 'manual') => autoSave.requestSave(reason),
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
    selectCard: (cardId) => store.getState().selectCard(cardId),
    openDocumentLayer: (cardId) => {
      const card = store.getState().cards.find((item) => item.cardId === cardId)
      if (card?.kind !== 'document') return
      store.getState().openDocumentLayer(cardId)
    },
    closeDocumentLayer: () => store.getState().closeDocumentLayer(),
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
