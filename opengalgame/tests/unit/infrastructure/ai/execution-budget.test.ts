import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'

const limits = { modelAttempts: 2, toolCalls: 2, activeMs: 1000, tokens: 10 }

afterEach(() => {
  vi.useRealTimers()
})

describe('执行预算', () => {
  it('沿用已有用量，未发生的调用不计数，实际尝试各计一次', () => {
    const budget = new ExecutionBudget(limits, {
      modelAttempts: 1,
      toolCalls: 0,
      activeMs: 20,
      tokens: 1
    })

    expect(budget.usage).toEqual({ modelAttempts: 1, toolCalls: 0, activeMs: 20, tokens: 1 })
    budget.consumeModelAttempt()
    budget.consumeToolCall()
    budget.consumeTokens(4)
    expect(budget.usage).toEqual({ modelAttempts: 2, toolCalls: 1, activeMs: 20, tokens: 5 })
    budget.consumeModelAttempt()
    expect(budget.usage.modelAttempts).toBe(3)
  })

  it('耗尽后再次消耗不增加计数，未配置 token 上限时只记录', () => {
    const budget = new ExecutionBudget({ modelAttempts: 1, toolCalls: 1, activeMs: 1000 })

    budget.consumeToolCall()
    budget.consumeToolCall()
    expect(budget.usage.toolCalls).toBe(2)
    budget.consumeTokens(100)
    expect(budget.usage.tokens).toBe(100)
  })

  it('普通模型与工具调用只统计，连续错误单独受限', () => {
    const budget = new ExecutionBudget({ modelAttempts: 1, toolCalls: 1, activeMs: 1000 })
    budget.consumeModelAttempt()
    budget.consumeModelAttempt()
    budget.consumeToolCall()
    budget.consumeToolCall()
    expect(budget.usage).toMatchObject({ modelAttempts: 2, toolCalls: 2 })
    for (let attempt = 0; attempt < 8; attempt += 1) budget.consumeErrorAttempt()
    expect(() => budget.consumeErrorAttempt()).toThrow('错误调用保护次数已用尽')
  })

  it('模型、工具、时间和 token 不再构成生成中止，错误次数仍受限', () => {
    const budget = new ExecutionBudget({
      modelAttempts: Number.MAX_SAFE_INTEGER,
      toolCalls: Number.MAX_SAFE_INTEGER,
      activeMs: Number.MAX_SAFE_INTEGER
    })
    budget.consumeModelAttempt()
    budget.consumeToolCall()
    budget.consumeTokens(1_000_000)
    expect(() => budget.assertModelAvailable()).not.toThrow()
    expect(() => budget.assertToolAvailable()).not.toThrow()
    for (let attempt = 0; attempt < 8; attempt += 1) budget.consumeErrorAttempt()
    expect(() => budget.consumeErrorAttempt()).toThrow('错误调用保护次数已用尽')
  })

  it('虚拟时钟下的活跃时间跨调用累计，不会自动重置', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
    const budget = new ExecutionBudget(limits)

    budget.startRun()
    vi.advanceTimersByTime(400)
    budget.finishRun()
    expect(budget.usage.activeMs).toBe(400)
    budget.startRun()
    vi.advanceTimersByTime(700)
    expect(budget.remainingActiveMs()).toBe(-100)
    expect(() => budget.assertActive()).toThrow('活跃执行时间已用尽')
    budget.finishRun()
    expect(budget.usage.activeMs).toBe(1100)
  })

  it('外层已开始计量时，调用方必须跳过再次开始和结算', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
    const budget = new ExecutionBudget(limits)

    budget.startRun()
    expect(budget.hasOpenRun()).toBe(true)
    expect(() => budget.startRun()).toThrow('执行预算已经在计量')
    vi.advanceTimersByTime(40)
    budget.finishRun()
    expect(budget.hasOpenRun()).toBe(false)
    expect(budget.usage.activeMs).toBe(40)
  })

  it('累计 token 超过上限时保留已发生的用量并失败', () => {
    const budget = new ExecutionBudget(limits)

    expect(() => budget.consumeTokens(11)).toThrow('累计 token 已用尽')
    expect(budget.usage.tokens).toBe(11)
  })

  it('输入和输出分开累计，缺失一侧不估算，恢复时不归零', () => {
    const budget = new ExecutionBudget(limits, { tokens: 4, inputTokens: 3, outputTokens: 1 })
    budget.consumeTokenUsage({ inputTokens: 2 })
    expect(budget.usage).toMatchObject({ tokens: 6, inputTokens: 5, outputTokens: 1 })
    const restored = new ExecutionBudget(limits, budget.usage)
    restored.consumeTokenUsage({ outputTokens: 2, totalTokens: 2 })
    expect(restored.usage).toMatchObject({ tokens: 8, inputTokens: 5, outputTokens: 3 })
  })
})
