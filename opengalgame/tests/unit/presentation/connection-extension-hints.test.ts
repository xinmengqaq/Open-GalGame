import { describe, expect, it } from 'vitest'

import { extensionProviderHint } from '@presentation/features/connection-settings/extensionHints'

describe('连接扩展可用键提示', () => {
  it('OpenAI 兼容提示自定义 User-Agent 可能被覆盖', () => {
    expect(extensionProviderHint('openai-compatible')).toContain('可能被 SDK 覆盖')
  })

  it('Anthropic 提示会保留自定义 User-Agent', () => {
    expect(extensionProviderHint('anthropic')).toContain('保留自定义 User-Agent')
  })

  it('只说明覆盖关系，不暴露请求头值', () => {
    for (const provider of ['openai-compatible', 'anthropic'] as const) {
      const hint = extensionProviderHint(provider)
      expect(hint).not.toMatch(/Bearer|sk-|x-opencode-session|:.*[A-Za-z0-9]{12}/)
    }
  })
})
