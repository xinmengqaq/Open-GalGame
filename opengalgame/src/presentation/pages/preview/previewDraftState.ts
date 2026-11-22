import type { DialogueTextEditDTO } from '@application/scene-preview/dto/DialogueSaveDTO'
import type { SceneDialogueVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

import { mergeCommittedEdits, normalizeDrafts } from './previewPresentation'

export type PreviewDraftHistoryEntry = {
  readonly dialogueId: string
  readonly before: string
  readonly after: string
}

export type PreviewDraftHistoryState = {
  readonly undo: readonly PreviewDraftHistoryEntry[]
  readonly redo: readonly PreviewDraftHistoryEntry[]
  readonly mergeOpen: boolean
}

export type PreviewDraftState = {
  readonly baseline: Record<string, string>
  readonly drafts: Record<string, string>
  readonly history: PreviewDraftHistoryState
}

export type PreviewDraftHistoryStep = {
  readonly state: PreviewDraftState
  readonly applied: PreviewDraftHistoryEntry | null
}

const closedHistory: PreviewDraftHistoryState = {
  undo: [],
  redo: [],
  mergeOpen: false
}

export function createPreviewDraftState(dialogues: readonly SceneDialogueVO[]): PreviewDraftState {
  return {
    baseline: Object.fromEntries(dialogues.map((dialogue) => [dialogue.dialogueId, dialogue.text])),
    drafts: {},
    history: closedHistory
  }
}

export function draftTextsOf(state: PreviewDraftState): Record<string, string> {
  return { ...state.baseline, ...state.drafts }
}

export function dirtyDraftIdsOf(state: PreviewDraftState): readonly string[] {
  return Object.keys(state.drafts).filter(
    (dialogueId) =>
      state.baseline[dialogueId] !== undefined &&
      state.drafts[dialogueId] !== state.baseline[dialogueId]
  )
}

export function blankDraftIdsOf(
  state: PreviewDraftState,
  dirtyIds: readonly string[]
): readonly string[] {
  return dirtyIds.filter((dialogueId) => (state.drafts[dialogueId] ?? '').trim() === '')
}

function withDraftText(
  baseline: Record<string, string>,
  drafts: Record<string, string>,
  dialogueId: string,
  text: string
): Record<string, string> {
  const baselineText = baseline[dialogueId]
  if (baselineText === undefined) return drafts
  const next = { ...drafts }
  if (text === baselineText) delete next[dialogueId]
  else next[dialogueId] = text
  return next
}

function recordEdit(
  history: PreviewDraftHistoryState,
  entry: PreviewDraftHistoryEntry
): PreviewDraftHistoryState {
  const last = history.undo.at(-1)
  if (history.mergeOpen && last !== undefined && last.dialogueId === entry.dialogueId) {
    if (last.after === entry.before) {
      const merged: PreviewDraftHistoryEntry = {
        dialogueId: entry.dialogueId,
        before: last.before,
        after: entry.after
      }
      if (merged.before === merged.after) {
        return { undo: history.undo.slice(0, -1), redo: [], mergeOpen: true }
      }
      return { undo: [...history.undo.slice(0, -1), merged], redo: [], mergeOpen: true }
    }
  }
  return { undo: [...history.undo, entry], redo: [], mergeOpen: true }
}

export function editPreviewDraft(
  state: PreviewDraftState,
  dialogueId: string,
  text: string
): PreviewDraftState {
  const baselineText = state.baseline[dialogueId]
  if (baselineText === undefined) return state
  const before = state.drafts[dialogueId] ?? baselineText
  if (before === text) return state
  const drafts = withDraftText(state.baseline, state.drafts, dialogueId, text)
  return {
    baseline: state.baseline,
    drafts,
    history: recordEdit(state.history, { dialogueId, before, after: text })
  }
}

export function closePreviewDraftEditing(state: PreviewDraftState): PreviewDraftState {
  if (!state.history.mergeOpen) return state
  return { ...state, history: { ...state.history, mergeOpen: false } }
}

export function undoPreviewDraft(state: PreviewDraftState): PreviewDraftHistoryStep {
  const entry = state.history.undo.at(-1)
  if (entry === undefined) return { state, applied: null }
  return {
    state: {
      baseline: state.baseline,
      drafts: withDraftText(state.baseline, state.drafts, entry.dialogueId, entry.before),
      history: {
        undo: state.history.undo.slice(0, -1),
        redo: [...state.history.redo, entry],
        mergeOpen: false
      }
    },
    applied: entry
  }
}

export function redoPreviewDraft(state: PreviewDraftState): PreviewDraftHistoryStep {
  const entry = state.history.redo.at(-1)
  if (entry === undefined) return { state, applied: null }
  return {
    state: {
      baseline: state.baseline,
      drafts: withDraftText(state.baseline, state.drafts, entry.dialogueId, entry.after),
      history: {
        undo: [...state.history.undo, entry],
        redo: state.history.redo.slice(0, -1),
        mergeOpen: false
      }
    },
    applied: entry
  }
}

export function commitPreviewDraftSave(
  state: PreviewDraftState,
  committedEdits: readonly DialogueTextEditDTO[]
): PreviewDraftState {
  const commits = committedEdits.filter((edit) => {
    const baselineText = state.baseline[edit.dialogueId]
    return baselineText !== undefined && baselineText !== edit.text
  })
  if (commits.length === 0) return closePreviewDraftEditing(state)
  const committedById = new Map<string, string>()
  for (const edit of commits) committedById.set(edit.dialogueId, edit.text)
  const baseline = mergeCommittedEdits(state.baseline, commits)
  const drafts = normalizeDrafts(state.drafts, baseline)
  const undo = state.history.undo.filter((entry) => !committedById.has(entry.dialogueId))
  const redo = state.history.redo.filter((entry) => !committedById.has(entry.dialogueId))
  const carried: PreviewDraftHistoryEntry[] = []
  for (const [dialogueId, committedText] of committedById) {
    const current = drafts[dialogueId]
    if (current !== undefined && current !== committedText) {
      carried.push({ dialogueId, before: committedText, after: current })
    }
  }
  return {
    baseline,
    drafts,
    history: { undo: [...undo, ...carried], redo, mergeOpen: false }
  }
}
