// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGuideState } from '@presentation/features/beginner-guide/advanceGuide'
import { GuideCopyText, guideCopySegments } from '@presentation/features/beginner-guide/GuideCopy'
import { GUIDE_STEP_ID, guideStepById } from '@presentation/features/beginner-guide/guideSteps'
import { locateGuideAction } from '@presentation/features/beginner-guide/locateGuideAction'
import { pageGuideTargets } from '@presentation/features/beginner-guide/useGuideMarkers'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function renderCopy(text: string): string {
  return renderToStaticMarkup(createElement(GuideCopyText, { text }))
}

describe('教程卡动作名强调', () => {
  it('只把成对直角引号内的控件名交给强调标记', () => {
    expect(guideCopySegments('点「导入文件」，再点「阅读文档」。')).toEqual([
      { text: '点', emphasis: false },
      { text: '「导入文件」', emphasis: true },
      { text: '，再点', emphasis: false },
      { text: '「阅读文档」', emphasis: true },
      { text: '。', emphasis: false }
    ])
    expect(guideCopySegments('没有成对引号「的文字')).toEqual([
      { text: '没有成对引号「的文字', emphasis: false }
    ])
  })

  it('第 3 步当前动作和下一步各自只强调真实按钮名', () => {
    const step = guideStepById(GUIDE_STEP_ID.importScript)
    const action = renderCopy(step.action)
    const next = renderCopy(step.next)

    expect(action).toMatch(/<strong[^>]*>「导入文件」<\/strong>/)
    expect(action.match(/<strong/g)).toHaveLength(1)
    expect(next).toMatch(/<strong[^>]*>「阅读文档」<\/strong>/)
    expect(next.match(/<strong/g)).toHaveLength(1)
  })

  it('普通文字仍按文本渲染，不把用户文案当 HTML', () => {
    expect(renderCopy('<b>不是标签</b>')).toBe('&lt;b&gt;不是标签&lt;/b&gt;')
  })
})

describe('页面目标筛选', () => {
  it('排除教程面板、入口和目录，只留下页面真实控件', () => {
    document.body.innerHTML = [
      '<button type="button" data-guide-target="file-import">导入文件</button>',
      '<div data-guide-portal="true">',
      '  <button type="button" data-guide-target="guide-confirm">编排好了</button>',
      '  <button type="button" data-guide-target="guide-skip">跳过</button>',
      '</div>'
    ].join('')
    const pageButton = document.querySelector<HTMLElement>('[data-guide-target="file-import"]')
    const guideButton = document.querySelector<HTMLElement>('[data-guide-target="guide-confirm"]')
    expect(pageButton).not.toBeNull()
    expect(guideButton).not.toBeNull()

    expect(pageGuideTargets([pageButton!, guideButton!])).toEqual([pageButton])
  })

  it('工程创建后指向项目卡片，等待生成时不给错误目标', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
      this: HTMLElement
    ) {
      return [{}] as unknown as DOMRectList
    })
    document.body.innerHTML = '<button data-testid="project-card" data-project-id="p-1"></button>'
    const projectState = {
      ...createGuideState({ stepId: GUIDE_STEP_ID.createProject }),
      milestoneIndex: 1,
      createdProjectId: 'p-1'
    }
    expect(locateGuideAction(projectState, null)[0]?.dataset.projectId).toBe('p-1')

    document.body.innerHTML = '<button data-action="generate"></button>'
    const waitingState = {
      ...createGuideState({ stepId: GUIDE_STEP_ID.saveAndGenerate }),
      milestoneIndex: 2,
      generationRunState: 'running' as const
    }
    expect(locateGuideAction(waitingState, null)).toEqual([])
  })

  it('放入剧本只标文件区真实来源行，不圈整块画布', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
      this: HTMLElement
    ) {
      return [{}] as unknown as DOMRectList
    })
    document.body.innerHTML = [
      '<div data-content-kind="text" data-text-kind="document" draggable="true"></div>',
      '<div data-testid="scene-canvas"></div>'
    ].join('')
    const state = createGuideState({ stepId: GUIDE_STEP_ID.importScript })

    expect(
      locateGuideAction(state, null).map(
        (target) => target.dataset.contentKind ?? target.dataset.testid
      )
    ).toEqual(['text'])
    expect(
      locateGuideAction({ ...state, milestoneIndex: 1 }, null).map(
        (target) => target.dataset.contentKind ?? target.dataset.testid
      )
    ).toEqual(['text'])

    document.body.innerHTML = '<button data-guide-target="file-import">导入文件</button>'
    expect(locateGuideAction(state, null)[0]?.dataset.guideTarget).toBe('file-import')
  })
})
