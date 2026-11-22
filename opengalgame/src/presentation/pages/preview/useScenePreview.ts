import { useCallback, useEffect, useRef } from 'react'

import type {
  PreviewPhase,
  PreviewPositionVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type {
  SceneDialogueVO,
  ScenePreviewIssueVO,
  ScenePreviewLockState,
  ScenePreviewSessionVO
} from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

import type { PreviewFailureView, PreviewSaveUiState } from './previewPresentation'
import { usePreviewDraftEditing } from './usePreviewDraftEditing'
import {
  usePreviewSaveSettlement,
  type PreviewSaveNotice,
  type PreviewSaveOutcome,
  type PreviewSavedVersion
} from './usePreviewSaveSettlement'
import {
  usePreviewSessionLifecycle,
  type PreviewSessionUiState
} from './usePreviewSessionLifecycle'
import {
  useScenePreviewAvailability,
  type ScenePreviewAvailabilityState
} from './useScenePreviewAvailability'
import {
  useScenePreviewStage,
  type PreviewStageUiState,
  type PreviewUpdateNotice
} from './useScenePreviewStage'

export type { PreviewSaveNotice, PreviewSaveOutcome, PreviewSavedVersion, PreviewSessionUiState }

interface UseScenePreviewOptions {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
  readonly onSavedVersion?: (saved: PreviewSavedVersion) => void
}

export interface UseScenePreviewResult {
  readonly availability: ScenePreviewAvailabilityState
  readonly refreshAvailability: () => void
  readonly sessionState: PreviewSessionUiState
  readonly openFailure: PreviewFailureView | null
  readonly retryOpen: () => void
  readonly reopen: () => Promise<boolean>
  readonly session: ScenePreviewSessionVO | null
  readonly sceneName: string | null
  readonly lockState: ScenePreviewLockState
  readonly dialogues: readonly SceneDialogueVO[]
  readonly issues: readonly ScenePreviewIssueVO[]
  readonly texts: Readonly<Record<string, string>>
  readonly dirtyIds: readonly string[]
  readonly dirtyCount: number
  readonly blankIds: readonly string[]
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly undo: () => void
  readonly redo: () => void
  readonly selectedDialogueId: string | null
  readonly editingDialogueId: string | null
  readonly selectDialogue: (dialogueId: string) => void
  readonly startEditing: (dialogueId: string) => void
  readonly finishEditing: () => void
  readonly updateDraft: (dialogueId: string, text: string) => void
  readonly canEditDialogue: (dialogueId: string) => boolean
  readonly stage: PreviewStageUiState
  readonly phase: PreviewPhase
  readonly position: PreviewPositionVO
  readonly stageBusy: boolean
  readonly iframeLoaded: boolean
  readonly startupPending: boolean
  readonly frameToken: number
  readonly controlsBlockedReason: string | null
  readonly locateFailure: PreviewFailureView | null
  readonly previewUpdateNotice: PreviewUpdateNotice | null
  readonly draftNotice: string | null
  readonly subscriptionNotice: string | null
  readonly onStageLoad: () => void
  readonly reloadFrame: () => void
  readonly prepareAgain: () => void
  readonly locateDialogue: (dialogueId: string) => void
  readonly retryLocate: () => void
  readonly retrySavedLocate: () => void
  readonly previousDialogue: () => void
  readonly nextDialogue: () => void
  readonly replayScene: () => void
  readonly canPrevious: boolean
  readonly canNext: boolean
  readonly saveState: PreviewSaveUiState
  readonly saveNotice: PreviewSaveNotice
  readonly save: () => Promise<PreviewSaveOutcome>
  readonly checkSettlement: () => Promise<void>
  readonly saveBlockedReason: string | null
  readonly closing: boolean
  readonly closeError: PreviewFailureView | null
  readonly closeSession: () => Promise<boolean>
}

export function useScenePreview({
  client,
  projectId,
  sceneId,
  onSavedVersion
}: UseScenePreviewOptions): UseScenePreviewResult {
  const availability = useScenePreviewAvailability({ client, projectId, sceneId })
  const draft = usePreviewDraftEditing()
  const saveInFlightRef = useRef(false)

  const lifecycle = usePreviewSessionLifecycle({
    client,
    projectId,
    sceneId,
    availabilityStatus: availability.state.status,
    initializeDraft: draft.initializeFromSession,
    resetDraft: draft.reset,
    closeDraft: draft.clearForClose,
    resetStage: () => stage.resetStage(),
    onSessionOpened: () => save.beginOpen(),
    onSessionClosed: () => save.markClosed(),
    onSessionReset: () => save.resetForSession()
  })

  const stageSession =
    lifecycle.session !== null && lifecycle.session.dialogues.length > 0
      ? lifecycle.session
      : null

  const stage = useScenePreviewStage({
    client,
    projectId,
    sceneId,
    session: stageSession,
    selectedDialogueIdRef: draft.selectedRef,
    draftsRef: draft.draftsRef,
    baselineRef: draft.baselineRef,
    saveInFlightRef,
    onSelectDialogue: draft.selectFromStage
  })

  const save = usePreviewSaveSettlement({
    client,
    projectId,
    sceneId,
    onSavedVersion,
    draft,
    lifecycle,
    stage,
    saveInFlightRef
  })

  const { syncSessionRef, syncLockBasisRefs } = lifecycle
  const { syncRefs } = draft
  const { syncStateRefs } = save

  useEffect(() => {
    syncSessionRef()
    syncRefs()
    syncLockBasisRefs()
    syncStateRefs()
  }, [syncRefs, syncLockBasisRefs, syncSessionRef, syncStateRefs])

  const { session, lockState, closing, closeError } = lifecycle

  const canEditDialogue = useCallback(
    (dialogueId: string) => {
      if (lockState !== 'editable') return false
      const dialogue = session?.dialogues.find((item) => item.dialogueId === dialogueId)
      return dialogue?.editable === true
    },
    [lockState, session]
  )

  const historyBlocked =
    lockState !== 'editable' ||
    save.saveState.status === 'saving' ||
    save.saveState.status === 'pending' ||
    closing ||
    draft.editingDialogueId !== null
  const canUndo = !historyBlocked && draft.draftState.history.undo.length > 0
  const canRedo = !historyBlocked && draft.draftState.history.redo.length > 0

  const applyHistoryStep = useCallback(
    (direction: 'undo' | 'redo') => {
      const step = direction === 'undo' ? draft.undoStep() : draft.redoStep()
      const entry = step.applied
      if (entry === null) return
      save.clearRejectedSave()
      stage.scheduleDraft(entry.dialogueId, direction === 'undo' ? entry.before : entry.after)
    },
    [draft.redoStep, draft.undoStep, save.clearRejectedSave, stage.scheduleDraft]
  )

  const undo = useCallback(() => {
    if (historyBlocked || saveInFlightRef.current || lifecycle.closingRef.current) return
    applyHistoryStep('undo')
  }, [applyHistoryStep, historyBlocked])

  const redo = useCallback(() => {
    if (historyBlocked || saveInFlightRef.current || lifecycle.closingRef.current) return
    applyHistoryStep('redo')
  }, [applyHistoryStep, historyBlocked])

  const selectDialogue = useCallback(
    (dialogueId: string) => {
      if (draft.editingRef.current !== null && draft.editingRef.current !== dialogueId) {
        draft.finishEditing()
      }
      stage.locateDialogue(dialogueId)
    },
    [draft.finishEditing, stage.locateDialogue]
  )

  const startEditing = useCallback(
    (dialogueId: string) => {
      if (!canEditDialogue(dialogueId)) {
        selectDialogue(dialogueId)
        return
      }
      if (draft.editingRef.current === dialogueId) return
      draft.finishEditing()
      draft.beginEditing(dialogueId)
      stage.locateDialogue(dialogueId)
    },
    [
      canEditDialogue,
      draft.beginEditing,
      draft.finishEditing,
      selectDialogue,
      stage.locateDialogue
    ]
  )

  const updateDraft = useCallback(
    (dialogueId: string, text: string) => {
      if (!canEditDialogue(dialogueId)) return
      draft.editDraft(dialogueId, text)
      save.clearRejectedSave()
      stage.scheduleDraft(dialogueId, text)
    },
    [canEditDialogue, draft.editDraft, save.clearRejectedSave, stage.scheduleDraft]
  )

  const dialogues = session?.dialogues ?? []
  const issues = session?.issues ?? []

  return {
    availability: availability.state,
    refreshAvailability: availability.refresh,
    sessionState: lifecycle.sessionState,
    openFailure: lifecycle.openFailure,
    retryOpen: lifecycle.retryOpen,
    reopen: lifecycle.reopen,
    session,
    sceneName: session?.sceneName ?? null,
    lockState,
    dialogues,
    issues,
    texts: draft.texts,
    dirtyIds: draft.dirtyIds,
    dirtyCount: draft.dirtyIds.length,
    blankIds: draft.blankIds,
    canUndo,
    canRedo,
    undo,
    redo,
    selectedDialogueId: draft.selectedDialogueId,
    editingDialogueId: draft.editingDialogueId,
    selectDialogue,
    startEditing,
    finishEditing: draft.finishEditing,
    updateDraft,
    canEditDialogue,
    stage: stage.stage,
    phase: stage.phase,
    position: stage.position,
    stageBusy: stage.stageBusy,
    iframeLoaded: stage.iframeLoaded,
    startupPending: stage.startupPending,
    frameToken: stage.frameToken,
    controlsBlockedReason: stage.controlsBlockedReason,
    locateFailure: stage.locateFailure,
    previewUpdateNotice: stage.previewUpdateNotice,
    draftNotice: stage.draftNotice,
    subscriptionNotice: stage.subscriptionNotice,
    onStageLoad: stage.onStageLoad,
    reloadFrame: stage.reloadFrame,
    prepareAgain: stage.prepareAgain,
    locateDialogue: stage.locateDialogue,
    retryLocate: stage.retryLocate,
    retrySavedLocate: stage.retrySavedLocate,
    previousDialogue: stage.previousDialogue,
    nextDialogue: stage.nextDialogue,
    replayScene: stage.replayScene,
    canPrevious: stage.canPrevious,
    canNext: stage.canNext,
    saveState: save.saveState,
    saveNotice: save.saveNotice,
    save: save.save,
    checkSettlement: save.checkSettlement,
    saveBlockedReason: save.saveBlockedReason,
    closing,
    closeError,
    closeSession: lifecycle.closeSession
  }
}
