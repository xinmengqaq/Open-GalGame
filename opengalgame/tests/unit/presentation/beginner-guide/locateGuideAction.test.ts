// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createGuideState,
  guideArrangeViewOf
} from '@presentation/features/beginner-guide/advanceGuide'
import { locateGuideAction } from '@presentation/features/beginner-guide/locateGuideAction'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
it('只标打开的工程表单；隐藏表单不能夺走首页入口标记', () => {
  document.body.innerHTML = '<button data-guide-target="project-create"></button><dialog><input id="project-name"><button data-guide-target="project-submit"></button></dialog>'
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function(this: HTMLElement) { return (this.closest('dialog:not([open])') ? [] : [{}]) as unknown as DOMRectList })
  const state = createGuideState({ stepId: 'create-project' })
  const locate = () => locateGuideAction(state, null)[0]
  expect(locate()?.dataset.guideTarget).toBe('project-create')
  document.querySelector('dialog')!.open = true
  expect(locate()?.id).toBe('project-name')
  document.querySelector('input')!.value = '新工程'
  expect(locate()?.dataset.guideTarget).toBe('project-submit')
  expect(locateGuideAction({ ...state, status: 'paused' }, null)).toEqual([])
})

it('第 3 步编辑器打开时标可见的返回画布，不圈被盖住的卡片', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    return [{}] as unknown as DOMRectList
  })
  document.body.innerHTML = [
    '<div class="react-flow__node" data-id="document-1" data-testid="scene-canvas">',
    '  <article data-card-surface="frame"></article>',
    '</div>',
    '<div data-testid="document-layer" role="dialog"><button data-guide-target="document-back">返回画布</button></div>'
  ].join('')
  const state = {
    ...createGuideState({ stepId: GUIDE_STEP_ID.importScript }),
    milestoneIndex: 2,
    documentCardId: 'document-1',
    documentEditorCardId: 'document-1'
  }
  expect(locateGuideAction(state, null)[0]?.dataset.guideTarget).toBe('document-back')
})

it('第 4 步写用途时标整张卡，不标文件名或用途文字内层', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    return [{}] as unknown as DOMRectList
  })
  document.body.innerHTML = [
    '<div class="react-flow__node" data-id="image-1">',
    '  <article data-card-surface="frame">',
    '    <h3>dormitory.png</h3>',
    '    <button aria-label="添加用途说明">未写用途说明</button>',
    '  </article>',
    '</div>'
  ].join('')
  const state = {
    ...createGuideState({ stepId: GUIDE_STEP_ID.arrangeScene }),
    milestoneIndex: 1,
    arrangeCards: { script: 'script-1', opening: 'image-1' }
  }
  const target = locateGuideAction(state, guideArrangeViewOf(state))[0]
  expect(target?.dataset.cardSurface).toBe('frame')
  expect(target?.tagName).toBe('ARTICLE')
})

it('第 7 步在预览里优先标实际对白行，草稿态标保存', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    return [{}] as unknown as DOMRectList
  })
  document.body.innerHTML = [
    '<div data-testid="preview-page">',
    '  <button data-guide-target="preview-return">返回工作台</button>',
    '  <div data-testid="preview-dialogue-list">',
    '    <div data-dialogue-id="d1" data-selected="true"><button data-guide-target="dialogue-row">第一句</button></div>',
    '    <div data-dialogue-id="d2"><button data-guide-target="dialogue-row">第二句</button></div>',
    '  </div>',
    '  <button data-guide-target="dialogue-save">保存</button>',
    '</div>'
  ].join('')
  const state = createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue })
  expect(locateGuideAction(state, null)[0]?.textContent).toBe('第一句')

  const editor = document.createElement('textarea')
  editor.setAttribute('data-guide-target', 'dialogue-editor')
  document.body.appendChild(editor)
  expect(locateGuideAction(state, null)[0]?.tagName).toBe('TEXTAREA')
  editor.remove()

  const dirty = { ...state, dialogueDraftDirty: true }
  expect(locateGuideAction(dirty, null)[0]?.dataset.guideTarget).toBe('dialogue-save')
})

it('第 7 步预览无对白时标真实返回控件；第 8 步预览交给返回脉冲', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    return [{}] as unknown as DOMRectList
  })
  document.body.innerHTML = [
    '<div data-testid="preview-page">',
    '  <button data-guide-target="preview-return">返回工作台</button>',
    '  <button data-guide-target="dialogue-save">保存</button>',
    '</div>'
  ].join('')
  const polish = createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue })
  expect(locateGuideAction(polish, null)[0]?.dataset.guideTarget).toBe('preview-return')

  const exportBuild = createGuideState({ stepId: GUIDE_STEP_ID.exportBuild })
  expect(locateGuideAction(exportBuild, null)).toEqual([])
})
