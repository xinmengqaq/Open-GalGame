import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type {
  PreviewFailureView,
  PreviewSaveUiState
} from '@presentation/pages/preview/previewPresentation'
import { PreviewSaveNotice } from '@presentation/pages/preview/PreviewSaveNotice'

const pendingFailure: PreviewFailureView = {
  code: 'saveOutcomeUnknown',
  message: '保存结果尚未核对',
  recovery: 'querySettlement'
}

function renderNotice(state: PreviewSaveUiState): string {
  return renderToStaticMarkup(
    createElement(PreviewSaveNotice, {
      state,
      blockedReason: null,
      canSave: true,
      onRetrySave: () => undefined,
      onReopen: () => undefined,
      onCheckSettlement: () => undefined
    })
  )
}

function pendingState(
  overrides: Partial<Extract<PreviewSaveUiState, { status: 'pending' }>> = {}
): Extract<PreviewSaveUiState, { status: 'pending' }> {
  return {
    status: 'pending',
    requestId: 'request-1',
    failure: pendingFailure,
    querying: false,
    queryNote: null,
    ...overrides
  }
}

describe('PreviewSaveNotice 保存待确认', () => {
  it('待确认时显示两行说明与「查看结果」按钮', () => {
    const html = renderNotice(pendingState())

    expect(html).toContain('保存结果待确认')
    expect(html).toContain('这次保存已经受理，结果还在核对，请先不要再次保存。')
    expect(html).toContain('查看结果')
    expect(html).not.toContain('正在查询…')
    expect(html).toContain('aria-busy="false"')
    expect(html).not.toContain('disabled=""')
  })

  it('查询中按钮禁用、可读且给出进行中反馈', () => {
    const html = renderNotice(pendingState({ querying: true }))

    expect(html).toContain('正在查询…')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('查看结果')
  })

  it('重新查询后仍待核对时显示带时间的可见提示', () => {
    const html = renderNotice(
      pendingState({ queryNote: '已于 09:12:34 重新查询，仍在核对' })
    )

    expect(html).toContain('已于 09:12:34 重新查询，仍在核对')
    expect(html).toContain('查看结果')
    expect(html).toContain('aria-busy="false"')
  })

  it('查询失败时显示失败提示并允许再次查看', () => {
    const html = renderNotice(pendingState({ queryNote: '查询失败，请稍后再试' }))

    expect(html).toContain('查询失败，请稍后再试')
    expect(html).toContain('查看结果')
    expect(html).not.toContain('disabled=""')
  })
})
