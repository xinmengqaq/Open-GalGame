import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { GenerationCompletedBubble } from '@presentation/pages/workbench/drawer/generation/GenerationConversation'

function renderBubble(
  overrides: {
    pending?: boolean
    startBlockedReason?: string | null
    onExport?: () => void
    exportDisabled?: boolean
    exportHint?: string
    exporting?: boolean
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(GenerationCompletedBubble, {
      onOpenWorks: () => undefined,
      onStart: () => undefined,
      pending: false,
      startBlockedReason: null,
      ...overrides
    })
  )
}

describe('GenerationCompletedBubble', () => {
  it('显示已提交结果与按画布重新生成入口', () => {
    const html = renderBubble()
    expect(html).toContain('已提交')
    expect(html).toContain('这一场已经写入作品，可以到作品历史查看。')
    expect(html).toContain('查看作品历史')
    expect(html).toContain('按画布重新生成')
    expect(html).toContain('重新读取已保存编排，不沿用上一候选。')
    expect(html).not.toContain('正在准备生成…')
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).not.toContain('disabled=""')
  })

  it('准备中时改用进行中文案并禁用重新生成', () => {
    const html = renderBubble({ pending: true })
    expect(html).toContain('正在准备生成…')
    expect(html).not.toContain('按画布重新生成')
    expect(html).toContain('disabled=""')
  })

  it('画布不可生成时禁用重新生成入口', () => {
    const html = renderBubble({ startBlockedReason: '先保存画布编排' })
    expect(html).toContain('按画布重新生成')
    expect(html).toContain('disabled=""')
  })

  it('接入导出动作后显示导出当前场景入口', () => {
    const html = renderBubble({ onExport: () => undefined })
    expect(html).toContain('导出当前场景')
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).not.toContain('正在导出…')
    expect(html).not.toContain('disabled=""')
  })

  it('导出进行中改用进行中文案并禁用', () => {
    const html = renderBubble({ onExport: () => undefined, exporting: true })
    expect(html).toContain('正在导出…')
    expect(html).not.toContain('导出当前场景')
    expect(html).toContain('disabled=""')
  })

  it('导出不可运行时禁用并保留提示', () => {
    const html = renderBubble({
      onExport: () => undefined,
      exportDisabled: true,
      exportHint: '还没有保存成功的场景内容；先在试玩预览里保存一次'
    })
    expect(html).toContain('导出当前场景')
    expect(html).toContain('title="还没有保存成功的场景内容；先在试玩预览里保存一次"')
    expect(html).toContain('disabled=""')
  })
})
