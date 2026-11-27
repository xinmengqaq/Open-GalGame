// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PreviewDialogueList } from '@presentation/pages/preview/PreviewDialogueList'
import { PreviewTopbar } from '@presentation/pages/preview/PreviewTopbar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
})

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root?.render(element)
  })
}

const noop = (): void => undefined

function dialogueList(dirtyIds: readonly string[], editingDialogueId: string | null): ReactElement {
  return createElement(PreviewDialogueList, {
    dialogues: [
      { dialogueId: 'd1', text: '第一句', editable: true },
      { dialogueId: 'd2', text: '第二句', editable: true }
    ],
    texts: { d1: '第一句', d2: '第二句' },
    dirtyIds,
    blankIds: [],
    issues: [],
    selectedDialogueId: 'd1',
    editingDialogueId,
    positionDialogueId: 'd1',
    phase: 'paused',
    lockState: 'editable',
    followEnabled: false,
    followAvailable: false,
    canEditDialogue: () => true,
    onSelectDialogue: noop,
    onStartEditing: noop,
    onFinishEditing: noop,
    onChangeText: noop,
    onFollowOn: noop,
    onFollowOff: noop
  })
}

describe('预览页操作反馈', () => {
  it('返回工作台是可读的标签按钮，并带有真实返回目标标记', async () => {
    await render(
      createElement(PreviewTopbar, {
        projectName: '预览工程',
        sceneName: 'start',
        sessionOpen: true,
        saveLabel: '已保存',
        saveTone: 'ok',
        saveDisabled: true,
        saveHint: null,
        saving: false,
        canUndo: false,
        canRedo: false,
        undoHint: '',
        redoHint: '',
        closing: false,
        onBack: noop,
        onSave: noop,
        onUndo: noop,
        onRedo: noop
      })
    )
    const button = document.querySelector<HTMLButtonElement>('[data-guide-return="preview"]')
    expect(button?.textContent).toContain('返回工作台')
    expect(button?.getAttribute('aria-label')).toBe('返回工作台')
    expect(button?.getAttribute('data-guide-target')).toBe('preview-return')
  })

  it('选中、正在修改和已修改都有可见状态，教程目标挂在真实控件上', async () => {
    await render(dialogueList([], null))
    const note = document.querySelector('[data-testid="preview-dialogue-list"] p')
    expect(note?.textContent).toContain('已选中第 1 句')
    expect(document.querySelector('[data-dialogue-id="d1"]')?.getAttribute('data-selected')).toBe(
      'true'
    )
    expect(document.querySelector('[data-guide-target="dialogue-row"]')).not.toBeNull()
    expect(document.querySelector('[data-guide-target="dialogue-edit"]')).not.toBeNull()

    await render(dialogueList([], 'd1'))
    expect(document.querySelector('[data-testid="preview-dialogue-list"] p')?.textContent).toContain(
      '正在修改第 1 句'
    )
    expect(document.querySelector('[data-guide-target="dialogue-editor"]')).not.toBeNull()

    await render(dialogueList(['d1'], null))
    expect(document.querySelector('[data-testid="preview-dialogue-list"] p')?.textContent).toContain(
      '已修改 1 句'
    )
    expect(document.querySelector('[data-dialogue-id="d1"] [aria-label="已修改"]')).not.toBeNull()
    expect(document.querySelector('[data-dialogue-id="d1"]')?.textContent).toContain('已修改')
  })
})
