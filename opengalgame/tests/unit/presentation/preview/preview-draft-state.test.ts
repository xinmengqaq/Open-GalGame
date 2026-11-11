import { describe, expect, it } from 'vitest'

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
  type PreviewDraftState
} from '@presentation/pages/preview/previewDraftState'
import type { SceneDialogueVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

const dialogues: readonly SceneDialogueVO[] = [
  { dialogueId: 'line-1', text: '雨点落在站台上。', editable: true },
  { dialogueId: 'line-2', text: '我把伞收起来。', editable: true },
  { dialogueId: 'line-3', text: '末班车还有十分钟。', editable: true }
]

function editedState(): PreviewDraftState {
  let state = createPreviewDraftState(dialogues)
  state = editPreviewDraft(state, 'line-1', '雨点落在铁皮顶上。')
  state = editPreviewDraft(state, 'line-1', '雨点落在铁皮顶上，声音很轻。')
  return state
}

describe('预览草稿状态', () => {
  it('读取正文与脏句只反映真实差异', () => {
    const state = editedState()

    expect(draftTextsOf(state)['line-1']).toBe('雨点落在铁皮顶上，声音很轻。')
    expect(dirtyDraftIdsOf(state)).toEqual(['line-1'])
    expect(blankDraftIdsOf(state, dirtyDraftIdsOf(state))).toEqual([])
  })

  it('同一句连续输入合并为一次撤销，撤销与重做都只作用于草稿', () => {
    const state = editedState()
    const undone = undoPreviewDraft(state)

    expect(undone.applied?.dialogueId).toBe('line-1')
    expect(undone.state.baseline['line-1']).toBe('雨点落在站台上。')
    expect(draftTextsOf(undone.state)['line-1']).toBe('雨点落在站台上。')
    expect(dirtyDraftIdsOf(undone.state)).toEqual([])

    const redone = redoPreviewDraft(undone.state)
    expect(draftTextsOf(redone.state)['line-1']).toBe('雨点落在铁皮顶上，声音很轻。')
    expect(dirtyDraftIdsOf(redone.state)).toEqual(['line-1'])
  })

  it('结束本次编辑后再次输入形成独立历史记录', () => {
    let state = editedState()
    state = closePreviewDraftEditing(state)
    state = editPreviewDraft(state, 'line-1', '雨点落在铁皮顶上，声音很轻。走吧。')

    expect(state.history.undo).toHaveLength(2)
    const once = undoPreviewDraft(state)
    expect(draftTextsOf(once.state)['line-1']).toBe('雨点落在铁皮顶上，声音很轻。')
    const twice = undoPreviewDraft(once.state)
    expect(draftTextsOf(twice.state)['line-1']).toBe('雨点落在站台上。')
  })

  it('新输入丢弃重做，空正文仍保留为草稿', () => {
    const undone = undoPreviewDraft(editedState())
    let state = editPreviewDraft(undone.state, 'line-2', '')
    state = editPreviewDraft(state, 'line-2', '   ')

    expect(state.history.redo).toHaveLength(0)
    expect(dirtyDraftIdsOf(state)).toEqual(['line-2'])
    expect(blankDraftIdsOf(state, dirtyDraftIdsOf(state))).toEqual(['line-2'])
  })

  it('保存成功后已提交正文成为新基线，保存期间的新草稿只保留当前差异', () => {
    let state = editedState()
    state = commitPreviewDraftSave(state, [
      { dialogueId: 'line-1', text: '雨点落在铁皮顶上，声音很轻。' }
    ])

    expect(state.baseline['line-1']).toBe('雨点落在铁皮顶上，声音很轻。')
    expect(dirtyDraftIdsOf(state)).toEqual([])
    expect(state.history.undo).toHaveLength(0)

    state = editPreviewDraft(state, 'line-1', '雨点落在铁皮顶上，声音很轻。走吧。')
    state = commitPreviewDraftSave(state, [])
    expect(dirtyDraftIdsOf(state)).toEqual(['line-1'])
  })

  it('保存期间产生的新草稿在提交后仍可撤销回已保存正文', () => {
    let state = editedState()
    state = editPreviewDraft(state, 'line-1', '雨点落在铁皮顶上，声音很轻。走吧。')
    const beforeSave = state
    state = closePreviewDraftEditing(beforeSave)
    state = editPreviewDraft(state, 'line-1', '雨点落在铁皮顶上，声音很轻。走吧。')
    state = commitPreviewDraftSave(state, [
      { dialogueId: 'line-1', text: '雨点落在铁皮顶上，声音很轻。' }
    ])

    expect(draftTextsOf(state)['line-1']).toBe('雨点落在铁皮顶上，声音很轻。走吧。')
    expect(dirtyDraftIdsOf(state)).toEqual(['line-1'])
    const undone = undoPreviewDraft(state)
    expect(draftTextsOf(undone.state)['line-1']).toBe('雨点落在铁皮顶上，声音很轻。')
  })
})
