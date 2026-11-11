import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SaveStatusView } from '@presentation/features/workbench-session/workbenchSaveStatus'
import { ToolbarActions } from '@presentation/pages/workbench/shell/ToolbarActions'
import type { WorkbenchToolbarAction } from '@presentation/pages/workbench/shell/workbenchActions'

const exportHint = '还没有保存成功的场景内容；先在试玩预览里保存一次'
const previewHint = '工作台还没准备好，暂不能试玩预览'

const saveStatus: SaveStatusView = {
  state: 'saved',
  label: '已保存',
  detail: null,
  tone: 'ok'
}

function sceneTool(overrides: Partial<WorkbenchToolbarAction> = {}): WorkbenchToolbarAction {
  return {
    id: 'export',
    label: '导出',
    icon: createElement('svg'),
    onInvoke: () => undefined,
    iconOnly: true,
    ...overrides
  }
}

function render(actions: readonly WorkbenchToolbarAction[]): string {
  return renderToStaticMarkup(
    createElement(ToolbarActions, { actions, compact: false, saveStatus })
  )
}

/** 取出第一个匹配的开始标签，按属性名读值；不依赖属性渲染顺序。 */
function tagOf(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern)
  return match ? match[0] : null
}

function attributeOf(tag: string | null, name: string): string | null {
  if (tag === null) return null
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match ? match[1] : null
}

function buttonTagOf(html: string, actionId: string): string | null {
  return tagOf(html, new RegExp(`<button[^>]*data-action="${actionId}"[^>]*>`))
}

function tooltipTagsOf(html: string): string[] {
  return html.match(/<span[^>]*role="tooltip"[^>]*>/g) ?? []
}

describe('ToolbarActions 场景工具禁用原因', () => {
  it('禁用且带原因时，button 与包裹层都指向同一个可见 tooltip', () => {
    const html = render([sceneTool({ disabled: true, hint: exportHint })])

    const tooltipTag = tooltipTagsOf(html)[0] ?? null
    expect(tooltipTag).not.toBeNull()
    const tooltipId = attributeOf(tooltipTag, 'id')
    expect(tooltipId).not.toBeNull()
    expect(tooltipId).not.toBe('')
    expect(html).toContain(`>${exportHint}</span>`)

    const buttonTag = buttonTagOf(html, 'export')
    expect(attributeOf(buttonTag, 'title')).toBe(exportHint)
    expect(attributeOf(buttonTag, 'aria-describedby')).toBe(tooltipId)
    expect(attributeOf(buttonTag, 'disabled')).not.toBeNull()

    const wrapTag = tagOf(html, /<span[^>]*data-hint="true"[^>]*>/)
    expect(wrapTag).not.toBeNull()
    expect(attributeOf(wrapTag, 'tabindex')).toBe('0')
    expect(attributeOf(wrapTag, 'aria-describedby')).toBe(tooltipId)
  })

  it('可用时保持原行为：不渲染 tooltip、不添加 aria-describedby 与焦点', () => {
    const html = render([sceneTool({ hint: exportHint })])

    expect(tooltipTagsOf(html)).toHaveLength(0)
    expect(html).not.toContain('role="tooltip"')
    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('tabindex="0"')
    expect(attributeOf(buttonTagOf(html, 'export'), 'title')).toBeNull()
    expect(html).toContain(`title="${exportHint}"`)
  })

  it('禁用但没有原因时不渲染 tooltip，也不把包裹层做成可聚焦', () => {
    const html = render([sceneTool({ disabled: true })])

    expect(tooltipTagsOf(html)).toHaveLength(0)
    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('tabindex="0"')
    expect(attributeOf(buttonTagOf(html, 'export'), 'title')).toBeNull()
  })

  it('原因只有空白时按没有原因处理', () => {
    const html = render([sceneTool({ disabled: true, hint: '   ' })])

    expect(tooltipTagsOf(html)).toHaveLength(0)
    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('tabindex="0"')
  })

  it('多个禁用场景工具各自使用独立的 tooltip id', () => {
    const html = render([
      sceneTool({ id: 'preview', label: '试玩预览', disabled: true, hint: previewHint }),
      sceneTool({ id: 'export', label: '导出', disabled: true, hint: exportHint })
    ])

    const tooltipTags = tooltipTagsOf(html)
    expect(tooltipTags).toHaveLength(2)
    const ids = tooltipTags.map((tag) => attributeOf(tag, 'id'))
    expect(ids.every((id) => id !== null && id !== '')).toBe(true)
    expect(new Set(ids).size).toBe(2)

    expect(attributeOf(buttonTagOf(html, 'preview'), 'aria-describedby')).toBe(ids[0])
    expect(attributeOf(buttonTagOf(html, 'export'), 'aria-describedby')).toBe(ids[1])
  })
})
