import { describe, expect, it, vi, type Mock } from 'vitest'

import { ConnectionSettingsApplicationServiceImpl } from '@application/connections/services/impl/ConnectionSettingsApplicationServiceImpl'
import type { ConnectionSettingsDTO } from '@application/connections/dto/ConnectionSettingsDTO'
import { AppException } from '@common/errors/AppException'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const secret = 'session-secret-value'
const stored: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  apiKey: 'stored-key',
  extension: { defaultHeaders: { 'x-opencode-session': secret } }
}
const draft: ConnectionSettingsDTO = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  apiKey: { kind: 'replace', value: 'new-key' }
}

interface ConnectionSettingsHarness {
  settings: {
    loadSettings: Mock
    saveSettings: Mock
  }
  model: {
    testConnection: Mock
    listModels: Mock
    validateProviderOptions: Mock
  }
  service: ConnectionSettingsApplicationServiceImpl
}

function createService(current: ConnectionSettingsInfo | null = stored): ConnectionSettingsHarness {
  const settings = {
    getSummary: vi.fn(),
    loadSettings: vi.fn(async () => current),
    saveSettings: vi.fn(async (value: ConnectionSettingsInfo) => ({
      providerId: value.providerId,
      baseUrl: value.baseUrl,
      model: value.model,
      contextWindow: value.contextWindow,
      maxOutputTokens: value.maxOutputTokens,
      hasApiKey: true,
      hasExtension: value.extension !== undefined
    }))
  }
  const model = {
    testConnection: vi.fn(async () => ({ available: true as const })),
    listModels: vi.fn(async () => ({ models: ['chosen'] })),
    validateProviderOptions: vi.fn()
  }
  return {
    settings,
    model,
    service: new ConnectionSettingsApplicationServiceImpl({ settings, model })
  }
}

describe('连接设置扩展编排', () => {
  it('缺省和保留都沿用已保存扩展，并在测试前校验', async () => {
    const { service, settings, model } = createService()
    await service.testConnection(draft)
    await service.testConnection({ ...draft, extension: { kind: 'keep' } })
    expect(settings.loadSettings).toHaveBeenCalledTimes(2)
    expect(model.validateProviderOptions).toHaveBeenCalledWith(
      'openai-compatible',
      stored.extension
    )
    expect(model.testConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'new-key', extension: stored.extension })
    )
  })

  it('清空去掉扩展且不再校验旧值，非法新值在保存前拒绝', async () => {
    const { service, settings, model } = createService()
    await service.saveSettings({ ...draft, extension: { kind: 'clear' } })
    expect(model.validateProviderOptions).not.toHaveBeenCalled()
    expect(settings.saveSettings.mock.calls[0]?.[0]).not.toHaveProperty('extension')

    model.validateProviderOptions.mockImplementation(() => {
      throw new AppException({
        code: 1401,
        msg: '扩展 JSON 的键 timeout 由应用控制或不会按填写值生效'
      })
    })
    await expect(
      service.saveSettings({
        ...draft,
        extension: { kind: 'set', value: `{"timeout":"${secret}"}` }
      })
    ).rejects.toMatchObject({ code: 1401, message: expect.not.stringContaining(secret) })
    expect(settings.saveSettings).toHaveBeenCalledTimes(1)
  })

  it('拉取列表先校验保留的扩展，并把已校验对象交给后续映射', async () => {
    const { service, model } = createService()
    await service.listModels({
      providerId: 'openai-compatible',
      baseUrl: stored.baseUrl,
      apiKey: { kind: 'keep' }
    })
    expect(model.validateProviderOptions).toHaveBeenCalledWith(
      'openai-compatible',
      stored.extension
    )
    expect(model.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: stored.apiKey, extension: stored.extension })
    )
  })
})
