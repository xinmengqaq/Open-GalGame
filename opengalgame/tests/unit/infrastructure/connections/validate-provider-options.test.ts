import { describe, expect, it } from 'vitest'

import { validateProviderOptions } from '@infrastructure/connections/validateProviderOptions'

const secret = 'session-secret-value'

describe('供应商扩展配置校验', () => {
  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 接受首版允许的 JSON 键',
    (providerId) => {
      expect(() =>
        validateProviderOptions(providerId, {
          defaultHeaders: { 'x-opencode-session': secret, 'User-Agent': 'custom-agent' },
          defaultQuery: { version: '1' },
          fetchOptions: { cache: 'no-store', headers: { 'x-trace': '1' } },
          logLevel: 'warn'
        })
      ).not.toThrow()
    }
  )

  it.each([
    'timeout',
    'maxRetries',
    'apiKey',
    'authToken',
    'baseURL',
    'fetch',
    'dangerouslyAllowBrowser',
    'logger',
    'middleware',
    'dispatcher',
    'unknownOption'
  ])('拒绝不会生效或未知的键 %s，错误不含值', (key) => {
    expect(() => validateProviderOptions('openai-compatible', { [key]: secret })).toThrowError(
      expect.objectContaining({ code: 1401, message: expect.stringContaining(key) })
    )
    try {
      validateProviderOptions('anthropic', { [key]: secret })
    } catch (error) {
      expect(error).toMatchObject({ code: 1401 })
      expect((error as Error).message).not.toContain(secret)
    }
  })

  it.each([
    { extension: { defaultHeaders: { '': secret } }, key: 'defaultHeaders' },
    { extension: { defaultHeaders: { 'x-opencode-session': 1 } }, key: 'defaultHeaders' },
    { extension: { defaultQuery: { ' ': secret } }, key: 'defaultQuery' },
    { extension: { defaultQuery: ['v'] }, key: 'defaultQuery' },
    { extension: { fetchOptions: { dispatcher: {} } }, key: 'dispatcher' },
    { extension: { logLevel: 'trace' }, key: 'logLevel' }
  ])('拒绝形状不对的 $key，错误不含值', ({ extension, key }) => {
    expect(() => validateProviderOptions('openai-compatible', extension)).toThrowError(
      expect.objectContaining({ code: 1401, message: expect.stringContaining(key) })
    )
    try {
      validateProviderOptions('openai-compatible', extension)
    } catch (error) {
      expect((error as Error).message).not.toContain(secret)
    }
  })
})
