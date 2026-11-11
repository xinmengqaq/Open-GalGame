import { describe, expect, it } from 'vitest'

import {
  buildConnectionSettingsRequest,
  buildListModelsRequest,
  connectionExtensionReducer,
  connectionExtensionRequest,
  emptyConnectionExtensionDraft,
  type ConnectionDraftFields,
  type ConnectionExtensionDraft
} from '@presentation/features/connection-settings/connectionDraft'

const fields: ConnectionDraftFields = {
  providerId: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'demo-chat',
  contextWindow: '128000',
  maxOutputTokens: '4096',
  temperature: '',
  topP: '',
  apiKey: ''
}

function configured(overrides: Partial<ConnectionExtensionDraft> = {}): ConnectionExtensionDraft {
  return { ...emptyConnectionExtensionDraft, hasExtension: true, ...overrides }
}

function typedState(value: string): ConnectionExtensionDraft {
  const opened = connectionExtensionReducer(emptyConnectionExtensionDraft, {
    type: 'editor-opened'
  })
  return connectionExtensionReducer(opened, { type: 'draft-changed', value })
}

describe('连接扩展 JSON 草稿', () => {
  it('未配置且未输入时不发送扩展字段，请求形状保持原样', () => {
    const state = emptyConnectionExtensionDraft
    const request = buildConnectionSettingsRequest(fields, connectionExtensionRequest(state))

    expect(connectionExtensionRequest(state)).toBeUndefined()
    expect(request).not.toHaveProperty('extension')
    expect(request).toEqual({
      providerId: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'demo-chat',
      contextWindow: 128000,
      maxOutputTokens: 4096,
      apiKey: { kind: 'keep' }
    })
  })

  it('已配置且未修改时发送保留，不会误发清空', () => {
    const state = configured()
    const request = buildConnectionSettingsRequest(fields, connectionExtensionRequest(state))

    expect(connectionExtensionRequest(state)).toEqual({ kind: 'keep' })
    expect(request.extension).toEqual({ kind: 'keep' })
  })

  it('输入新 JSON 时整体设置，保存和测试共用同一请求形状', () => {
    const value = '{ "defaultHeaders": { "X-Test-Header": "fixture" } }'
    const state = typedState(value)
    const request = buildConnectionSettingsRequest(fields, connectionExtensionRequest(state))
    const listRequest = buildListModelsRequest(
      { providerId: fields.providerId, baseUrl: fields.baseUrl, apiKey: fields.apiKey },
      connectionExtensionRequest(state)
    )

    expect(state.mode).toBe('set')
    expect(request.extension).toEqual({ kind: 'set', value })
    expect(listRequest.extension).toEqual({ kind: 'set', value })
  })

  it('已配置时清空空白输入仍保留，不把未修改当成清空', () => {
    const state = connectionExtensionReducer(configured({ editorOpen: true }), {
      type: 'draft-changed',
      value: '   '
    })

    expect(state.mode).toBe('keep')
    expect(connectionExtensionRequest(state)).toEqual({ kind: 'keep' })
  })

  it('点清空只进入确认，确认后才发送清空并保留摘要状态', () => {
    const requested = connectionExtensionReducer(configured(), { type: 'clear-requested' })

    expect(requested.confirmingClear).toBe(true)
    expect(connectionExtensionRequest(requested)).toEqual({ kind: 'keep' })

    const cancelled = connectionExtensionReducer(requested, { type: 'clear-cancelled' })
    expect(cancelled.confirmingClear).toBe(false)
    expect(connectionExtensionRequest(cancelled)).toEqual({ kind: 'keep' })

    const confirmed = connectionExtensionReducer(requested, { type: 'clear-confirmed' })
    expect(confirmed.confirmingClear).toBe(false)
    expect(confirmed.hasExtension).toBe(true)
    expect(connectionExtensionRequest(confirmed)).toEqual({ kind: 'clear' })
  })

  it('保存清空成功后摘要更新为未配置', () => {
    const confirmed = connectionExtensionReducer(configured(), { type: 'clear-confirmed' })
    const saved = connectionExtensionReducer(confirmed, {
      type: 'save-finished',
      hasExtension: false
    })

    expect(saved.hasExtension).toBe(false)
    expect(saved.mode).toBe('keep')
    expect(saved.editorOpen).toBe(false)
    expect(connectionExtensionRequest(saved)).toBeUndefined()
  })

  it('保存设置成功后收起输入并按返回摘要标记已配置', () => {
    const state = typedState('{ "logLevel": "warn" }')
    const saved = connectionExtensionReducer(state, {
      type: 'save-finished',
      hasExtension: true
    })

    expect(saved.hasExtension).toBe(true)
    expect(saved.draft).toBe('')
    expect(saved.editorOpen).toBe(false)
    expect(saved.mode).toBe('keep')
    expect(connectionExtensionRequest(saved)).toEqual({ kind: 'keep' })
  })

  it('保存失败不改动草稿，用户输入与展开状态保留', () => {
    const value = '{ "logLevel": "warn" }'
    const state = typedState(value)
    const failed = connectionExtensionReducer(state, { type: 'save-finished' })

    expect(failed).toBe(state)
    expect(failed.draft).toBe(value)
    expect(failed.editorOpen).toBe(true)
    expect(connectionExtensionRequest(failed)).toEqual({ kind: 'set', value })
  })

  it('清空后撤销回到保留已配置状态', () => {
    const confirmed = connectionExtensionReducer(configured(), { type: 'clear-confirmed' })
    const undone = connectionExtensionReducer(confirmed, { type: 'clear-undone' })

    expect(undone.mode).toBe('keep')
    expect(connectionExtensionRequest(undone)).toEqual({ kind: 'keep' })
  })

  it('关闭弹窗清理草稿，下次摘要加载只带 hasExtension', () => {
    const state = typedState('{ "logLevel": "warn" }')
    const closed = connectionExtensionReducer(state, { type: 'closed' })

    expect(closed).toEqual(emptyConnectionExtensionDraft)

    const loaded = connectionExtensionReducer(closed, {
      type: 'summary-loaded',
      hasExtension: true
    })
    expect(loaded).toEqual(configured())
  })
})
