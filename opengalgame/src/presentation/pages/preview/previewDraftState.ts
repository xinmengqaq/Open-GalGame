import type { DialogueTextEditDTO } from '@application/scene-preview/dto/DialogueSaveDTO'
import type { SceneDialogueVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

import { mergeCommittedEdits, normalizeDrafts } from './previewPresentation'

/**
 * 预览页专属的草稿编辑历史。
 * 它只描述未保存草稿：已保存正文成为基线，已提交内容不会进入撤销/重做。
 */
export type PreviewDraftHistoryEntry = {
  readonly dialogueId: string
  readonly before: string
  readonly after: string
}

export type PreviewDraftHistoryState = {
  readonly undo: readonly PreviewDraftHistoryEntry[]
  readonly redo: readonly PreviewDraftHistoryEntry[]
  /** 同一次连续输入是否还允许并入上一条记录。失焦、撤销、重做和保存都会结束合并。 */
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

/** 记录一次真实正文输入；同一句连续输入合并，新输入丢弃重做。 */
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

/** 失焦、Esc 或开始另一句时结束本次连续输入，不改变草稿。 */
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

/**
 * 已确认提交的正文成为新基线。
 * 只保留真正的提交：与旧基线相同的编辑不会压缩未保存历史。
 * 保存期间又产生的新草稿只保留“已保存正文 → 当前草稿”这一条，
 * 撤销不会回到提交前的内容。
 */
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
