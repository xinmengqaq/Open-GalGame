import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { estimateTokens, evaluateContextBudget } from '@infrastructure/ai/context/contextBudget'

describe('上下文预算', () => {
  it('估算不把字符数当作 token，中文按更保守的方式计算', () => {
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('abcd')).not.toBe(4)
    expect(estimateTokens('你好')).toBe(4)
    expect(estimateTokens('你好')).toBeGreaterThan(Math.ceil('你好'.length / 4))
  })

  it('较小窗口扣除工具定义、输出预留和安全余量，不套用固定 24000', () => {
    const decision = evaluateContextBudget({
      windowTokens: 100,
      safetyFraction: 0.1,
      reservedOutputTokens: 30,
      inputBudgetTokens: 24000,
      systemPrompt: '规则',
      toolDefinitions: [{ name: 'echo', description: 'x'.repeat(40) }],
      messages: [{ content: 'hi' }]
    })

    expect(decision.allowedTokens).toBeLessThan(100)
    expect(decision.allowedTokens).toBeLessThanOrEqual(60)
    expect(decision.allowedTokens).not.toBe(24000)
  })

  it('必需内容超过可用空间时失败', () => {
    let caught: unknown
    try {
      evaluateContextBudget({
        windowTokens: 40,
        safetyFraction: 0.1,
        reservedOutputTokens: 10,
        systemPrompt: '必须保留的系统规则'.repeat(20),
        toolDefinitions: [],
        messages: [{ content: '也必须留下', required: true }]
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppException)
    expect(caught).toMatchObject({
      message: '必需内容超过上下文预算',
      diagnosticCategory: 'context'
    })
  })

  it('裁剪旧消息时保持工具调用和结果成对', () => {
    const call = { content: 'go', toolCallIds: ['call-1'] }
    const result = { content: 'yes', toolCallId: 'call-1' }
    const decision = evaluateContextBudget({
      windowTokens: 200,
      safetyFraction: 0.1,
      reservedOutputTokens: 20,
      systemPrompt: 'ab',
      toolDefinitions: [],
      messages: [{ content: 'x'.repeat(600) }, call, result, { content: 'ok', required: true }]
    })

    const kept = decision.messages
    const hasCall = kept.includes(call)
    const hasResult = kept.includes(result)
    expect(hasCall).toBe(hasResult)
    expect(hasCall).toBe(true)
    expect(kept.some((message) => message.content === 'ok')).toBe(true)
    expect(kept.some((message) => message.content.startsWith('xxx'))).toBe(false)
  })

  it('非必需消息全部放不下时失败，而不是返回空请求', () => {
    expect(() =>
      evaluateContextBudget({
        windowTokens: 40,
        safetyFraction: 0.1,
        reservedOutputTokens: 8,
        systemPrompt: '规则',
        toolDefinitions: [],
        messages: [{ content: '长'.repeat(80) }]
      })
    ).toThrow('本次输入超过上下文预算')
  })
})
