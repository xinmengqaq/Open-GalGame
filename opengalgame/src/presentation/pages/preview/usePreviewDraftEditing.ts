import { useCallback, useMemo, useRef, useState } from 'react'

import type { DialogueTextEditDTO } from '@application/scene-preview/dto/DialogueSaveDTO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

import {
  blankDraftIdsOf,
  closePreviewDraftEditing,
  commitPreviewDraftSave,
  createPreviewDraftState,
  dirtyDraftIdsOf,
  draftTextsOf,
  editPreviewDraft,
  redoPreviewDraft,
  undoPreviewDraft,
  type PreviewDraftHistoryStep,
  type PreviewDraftState
} from './previewDraftState'

export type MutableRef<T> = { current: T }

export interface UsePreviewDraftEditingResult {
  readonly draftState: PreviewDraftState
  readonly selectedDialogueId: string | null
  readonly editingDialogueId: string | null
  readonly texts: Readonly<Record<string, string>>
  readonly dirtyIds: readonly string[]
  readonly blankIds: readonly string[]
  readonly draftStateRef: MutableRef<PreviewDraftState>
  readonly baselineRef: MutableRef<Record<string, string>>
  readonly draftsRef: MutableRef<Record<string, string>>
  readonly selectedRef: MutableRef<string | null>
  readonly editingRef: MutableRef<string | null>
  readonly initializeFromSession: (session: ScenePreviewSessionVO) => void
  readonly reset: () => void
  readonly clearForClose: () => void
  readonly selectFromStage: (dialogueId: string) => void
  readonly beginEditing: (dialogueId: string) => void
  readonly finishEditing: () => void
  readonly editDraft: (dialogueId: string, text: string) => void
  readonly undoStep: () => PreviewDraftHistoryStep
  readonly redoStep: () => PreviewDraftHistoryStep
  readonly commitSaved: (edits: readonly DialogueTextEditDTO[]) => void
  readonly closeEditingState: () => void
  readonly syncRefs: () => void
}

export function usePreviewDraftEditing(): UsePreviewDraftEditingResult {
  const [draftState, setDraftState] = useState<PreviewDraftState>(() =>
    createPreviewDraftState([])
  )
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(null)
  const [editingDialogueId, setEditingDialogueId] = useState<string | null>(null)

  const baselineRef = useRef<Record<string, string>>({})
  const draftsRef = useRef<Record<string, string>>({})
  const draftStateRef = useRef<PreviewDraftState>(draftState)
  const selectedRef = useRef<string | null>(null)
  const editingRef = useRef<string | null>(null)

  const applyState = useCallback((next: PreviewDraftState) => {
    draftStateRef.current = next
    baselineRef.current = next.baseline
    draftsRef.current = next.drafts
    setDraftState(next)
  }, [])

  const initializeFromSession = useCallback(
    (session: ScenePreviewSessionVO) => {
      const next = createPreviewDraftState(session.dialogues)
      const firstEditable =
        session.dialogues.find((dialogue) => dialogue.editable) ?? session.dialogues[0]
      draftStateRef.current = next
      baselineRef.current = next.baseline
      draftsRef.current = next.drafts
      selectedRef.current = firstEditable?.dialogueId ?? null
      setDraftState(next)
      setSelectedDialogueId(firstEditable?.dialogueId ?? null)
      setEditingDialogueId(null)
    },
    []
  )

  const reset = useCallback(() => {
    const next = createPreviewDraftState([])
    draftStateRef.current = next
    baselineRef.current = next.baseline
    draftsRef.current = next.drafts
    selectedRef.current = null
    editingRef.current = null
    setDraftState(next)
    setSelectedDialogueId(null)
    setEditingDialogueId(null)
  }, [])

  const clearForClose = useCallback(() => {
    applyState(createPreviewDraftState([]))
    setSelectedDialogueId(null)
    setEditingDialogueId(null)
  }, [applyState])

  const selectFromStage = useCallback((dialogueId: string) => {
    selectedRef.current = dialogueId
    setSelectedDialogueId(dialogueId)
  }, [])

  const beginEditing = useCallback((dialogueId: string) => {
    editingRef.current = dialogueId
    setEditingDialogueId(dialogueId)
  }, [])

  const finishEditing = useCallback(() => {
    editingRef.current = null
    setEditingDialogueId(null)
    applyState(closePreviewDraftEditing(draftStateRef.current))
  }, [applyState])

  const editDraft = useCallback(
    (dialogueId: string, text: string) => {
      applyState(editPreviewDraft(draftStateRef.current, dialogueId, text))
    },
    [applyState]
  )

  const undoStep = useCallback(() => {
    const step = undoPreviewDraft(draftStateRef.current)
    if (step.applied !== null) applyState(step.state)
    return step
  }, [applyState])

  const redoStep = useCallback(() => {
    const step = redoPreviewDraft(draftStateRef.current)
    if (step.applied !== null) applyState(step.state)
    return step
  }, [applyState])

  const commitSaved = useCallback(
    (edits: readonly DialogueTextEditDTO[]) => {
      applyState(commitPreviewDraftSave(draftStateRef.current, edits))
    },
    [applyState]
  )

  const closeEditingState = useCallback(() => {
    applyState(closePreviewDraftEditing(draftStateRef.current))
  }, [applyState])

  const syncRefs = useCallback(() => {
    selectedRef.current = selectedDialogueId
    editingRef.current = editingDialogueId
  }, [editingDialogueId, selectedDialogueId])

  const dirtyIds = useMemo(() => dirtyDraftIdsOf(draftState), [draftState])
  const blankIds = useMemo(() => blankDraftIdsOf(draftState, dirtyIds), [dirtyIds, draftState])
  const texts = useMemo(() => draftTextsOf(draftState), [draftState])

  return {
    draftState,
    selectedDialogueId,
    editingDialogueId,
    texts,
    dirtyIds,
    blankIds,
    draftStateRef,
    baselineRef,
    draftsRef,
    selectedRef,
    editingRef,
    initializeFromSession,
    reset,
    clearForClose,
    selectFromStage,
    beginEditing,
    finishEditing,
    editDraft,
    undoStep,
    redoStep,
    commitSaved,
    closeEditingState,
    syncRefs
  }
}
