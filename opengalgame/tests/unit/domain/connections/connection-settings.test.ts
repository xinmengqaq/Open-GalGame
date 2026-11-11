import { describe, expect, it } from 'vitest'

import {
  connectionExtensionMaxBytes,
  resolveConnectionAccess,
  resolveConnectionExtension,
  resolveConnectionSettings
} from '@domain/connections/services/resolveConnectionSettings'

const current = {
  providerId: 'openai-compatible' as const,
  baseUrl: 'https://service.example/v1',
  model: 'old',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.4,
  topP: undefined,
  apiKey: 'stored-secret'
}
const input = {
  ...current,
  apiKey: { kind: 'keep' as const },
  extension: { kind: 'keep' as const }
}

describe('连接凭据领域规则', () => {
  it('同一地址允许保留凭据并变更模型，地址先规范化', () => {
    expect(
      resolveConnectionSettings({
        input: { ...input, baseUrl: current.baseUrl + '/', model: ' new ' },
        current
      })
    ).toEqual({ ...current, model: 'new' })
  })
  it('初次配置或更换地址不能保留旧凭据', () => {
    expect(() => resolveConnectionSettings({ input, current: null })).toThrowError(
      expect.objectContaining({ code: 1401 })
    )
    expect(() =>
      resolveConnectionSettings({
        input: { ...input, baseUrl: 'https://other.example/v1' },
        current
      })
    ).toThrowError(expect.objectContaining({ code: 1401 }))
  })
  it('更换地址可以显式替换凭据，空密钥仍被拒绝', () => {
    expect(
      resolveConnectionSettings({
        input: {
          ...input,
          baseUrl: 'https://other.example',
          apiKey: { kind: 'replace', value: ' new-key ' }
        },
        current
      }).apiKey
    ).toBe('new-key')
    expect(() =>
      resolveConnectionSettings({
        input: { ...input, apiKey: { kind: 'replace', value: ' ' } },
        current
      })
    ).toThrowError(expect.objectContaining({ code: 1401 }))
  })
  it('Anthropic 协议保留完整模型配置，切换协议不能沿用旧密钥', () => {
    const anthropic = { ...input, providerId: 'anthropic' as const }
    expect(() => resolveConnectionSettings({ input: anthropic, current })).toThrowError(
      expect.objectContaining({ code: 1401 })
    )
    expect(
      resolveConnectionSettings({
        input: { ...anthropic, apiKey: { kind: 'replace', value: 'anthropic-key' } },
        current
      })
    ).toMatchObject({ providerId: 'anthropic', contextWindow: 128000, maxOutputTokens: 4096 })
  })
  it.each([
    { invalid: { model: ' ' }, message: '模型名称不能为空' },
    { invalid: { contextWindow: 0 }, message: '上下文窗口必须为正整数' },
    { invalid: { contextWindow: 1.5 }, message: '上下文窗口必须为正整数' },
    { invalid: { maxOutputTokens: 0 }, message: '最大输出 token 必须为正整数' },
    { invalid: { maxOutputTokens: 128001 }, message: '最大输出 token 不能超过上下文窗口' },
    { invalid: { temperature: -0.1 }, message: '温度必须为 0 到 1 之间的有限数值' },
    { invalid: { temperature: 1.1 }, message: '温度必须为 0 到 1 之间的有限数值' },
    { invalid: { topP: -0.1 }, message: 'top-p 必须为 0 到 1 之间的有限数值' },
    { invalid: { topP: 1.1 }, message: 'top-p 必须为 0 到 1 之间的有限数值' }
  ])('拒绝非法模型配置并说明具体原因：$message', ({ invalid, message }) => {
    expect(() =>
      resolveConnectionSettings({ input: { ...input, ...invalid }, current })
    ).toThrowError(expect.objectContaining({ code: 1401, message }))
  })
  it('温度与 top-p 只能选择一种采样控制', () => {
    expect(() =>
      resolveConnectionSettings({ input: { ...input, topP: 0.9 }, current })
    ).toThrowError(expect.objectContaining({ code: 1401, message: '温度与 top-p 只能填写一个' }))
  })
  it('拉取列表只校验地址与密钥，不要求模型或窗口', () => {
    expect(
      resolveConnectionAccess({
        input: {
          providerId: current.providerId,
          baseUrl: current.baseUrl + '/',
          apiKey: input.apiKey,
          extension: input.extension
        },
        current
      })
    ).toEqual({
      providerId: current.providerId,
      baseUrl: current.baseUrl,
      apiKey: current.apiKey
    })
  })
  it('初次配置或更换地址时，拉取列表也不能保留旧密钥', () => {
    expect(() =>
      resolveConnectionAccess({
        input: {
          providerId: current.providerId,
          baseUrl: current.baseUrl,
          apiKey: { kind: 'keep' },
          extension: { kind: 'keep' }
        },
        current: null
      })
    ).toThrowError(expect.objectContaining({ code: 1401 }))
  })
  it.each([
    'broken',
    'file:///secret',
    'https://name:password@service.example',
    'https://service.example?q=secret',
    'https://service.example/#secret'
  ])('拒绝不安全地址 %s', (baseUrl) => {
    expect(() => resolveConnectionSettings({ input: { ...input, baseUrl }, current })).toThrowError(
      expect.objectContaining({ code: 1401 })
    )
  })
})

describe('扩展 JSON 结构', () => {
  const secret = 'session-secret-value'
  it('保留、替换和清空互不混淆', () => {
    const stored = { defaultHeaders: { 'x-opencode-session': secret } }
    expect(resolveConnectionExtension({ kind: 'keep' }, stored)).toEqual(stored)
    expect(resolveConnectionExtension({ kind: 'keep' }, undefined)).toBeUndefined()
    expect(resolveConnectionExtension({ kind: 'clear' }, stored)).toBeUndefined()
    expect(
      resolveConnectionSettings({
        input: { ...input, extension: { kind: 'set', value: '{"defaultQuery":{"v":"1"}}' } },
        current
      }).extension
    ).toEqual({ defaultQuery: { v: '1' } })
    expect(
      resolveConnectionSettings({ input: { ...input, extension: { kind: 'clear' } }, current })
    ).not.toHaveProperty('extension')
  })
  it.each([
    { value: '{', message: '扩展 JSON 格式不正确' },
    { value: '[]', message: '扩展 JSON 必须是对象' },
    { value: 'null', message: '扩展 JSON 必须是对象' },
    { value: '"text"', message: '扩展 JSON 必须是对象' },
    { value: `{"constructor":"${secret}"}`, message: '扩展 JSON 不能包含键 constructor' },
    { value: '{"nested":{"prototype":1}}', message: '扩展 JSON 不能包含键 prototype' },
    { value: '{"items":[{"__proto__":{}}]}', message: '扩展 JSON 不能包含键 __proto__' },
    {
      value: ' '.repeat(connectionExtensionMaxBytes + 1),
      message: `扩展 JSON 不能超过 ${connectionExtensionMaxBytes} 字节`
    }
  ])('拒绝非法扩展：$message', ({ value, message }) => {
    expect(() => resolveConnectionExtension({ kind: 'set', value }, undefined)).toThrowError(
      expect.objectContaining({ code: 1401, message })
    )
    expect(message).not.toContain(secret)
  })
  it('多字节字符按 UTF-8 字节计上限', () => {
    const value = `{"k":"${'中'.repeat(3000)}"}`
    expect(Buffer.byteLength(value)).toBeGreaterThan(connectionExtensionMaxBytes)
    expect(() => resolveConnectionExtension({ kind: 'set', value }, undefined)).toThrowError(
      expect.objectContaining({
        code: 1401,
        message: `扩展 JSON 不能超过 ${connectionExtensionMaxBytes} 字节`
      })
    )
  })
})
