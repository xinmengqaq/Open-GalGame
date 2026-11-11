import { describe, expect, it } from 'vitest'

import {
  assembleAgentExecutionProfile,
  suggestedActiveLimitMs,
  suggestedContextInputBudgetTokens,
  suggestedContextSafetyFraction,
  suggestedModelAttemptLimit,
  suggestedTechnicalRetryCount,
  suggestedTechnicalRetryDelayMs,
  suggestedToolCallLimit,
  suggestedToolResultCharLimit,
  suggestedToolTimeoutMs
} from '@infrastructure/ai/config/agentExecutionConfig'

describe('Agent 执行配置', () => {
  it('没有显式值时使用建议默认值，并且不包含模型参数', () => {
    const profile = assembleAgentExecutionProfile()

    expect(profile).toEqual({
      modelAttemptLimit: suggestedModelAttemptLimit,
      toolCallLimit: suggestedToolCallLimit,
      activeLimitMs: suggestedActiveLimitMs,
      toolTimeoutMs: suggestedToolTimeoutMs,
      technicalRetryCount: suggestedTechnicalRetryCount,
      technicalRetryDelayMs: suggestedTechnicalRetryDelayMs,
      contextInputBudgetTokens: suggestedContextInputBudgetTokens,
      contextSafetyFraction: suggestedContextSafetyFraction,
      toolResultCharLimit: suggestedToolResultCharLimit
    })
    expect(profile).not.toHaveProperty('temperature')
    expect(profile).not.toHaveProperty('requestTimeoutMs')
    expect(profile).not.toHaveProperty('cumulativeTokenLimit')
  })

  it('本次指定优先于实现类覆盖和用户级参数', () => {
    const profile = assembleAgentExecutionProfile({
      user: { modelAttemptLimit: 4, toolCallLimit: 6 },
      definition: { modelAttemptLimit: 8, activeLimitMs: 120000 },
      override: { modelAttemptLimit: 3 }
    })

    expect(profile.modelAttemptLimit).toBe(3)
    expect(profile.toolCallLimit).toBe(6)
    expect(profile.activeLimitMs).toBe(120000)
  })

  it('重试次数可以明确为 0，正数限制为 0 时失败且不被默认值覆盖', () => {
    expect(
      assembleAgentExecutionProfile({ override: { technicalRetryCount: 0 } }).technicalRetryCount
    ).toBe(0)
    expect(() => assembleAgentExecutionProfile({ override: { modelAttemptLimit: 0 } })).toThrow(
      '模型请求尝试上限必须为正整数'
    )
    expect(() => assembleAgentExecutionProfile({ user: { toolTimeoutMs: -1 } })).toThrow(
      '工具超时必须为正整数'
    )
  })

  it('显式省略工具超时不回退建议值，其他覆盖仍生效', () => {
    const profile = assembleAgentExecutionProfile({
      user: { toolTimeoutMs: 20000 },
      override: { toolTimeoutMs: undefined, modelAttemptLimit: 3 }
    })

    expect(profile).not.toHaveProperty('toolTimeoutMs')
    expect(profile.modelAttemptLimit).toBe(3)
    expect(JSON.stringify(profile)).not.toContain('2147483647')
  })

  it('拒绝个位数秒的重试等待，并接受可选的累计 token 上限', () => {
    expect(() =>
      assembleAgentExecutionProfile({ override: { technicalRetryDelayMs: 9000 } })
    ).toThrow('技术重试等待不能短于 10 秒')
    expect(() => assembleAgentExecutionProfile({ override: { cumulativeTokenLimit: 0 } })).toThrow(
      '累计 token 上限必须为正整数'
    )
    expect(
      assembleAgentExecutionProfile({ override: { cumulativeTokenLimit: 50 } }).cumulativeTokenLimit
    ).toBe(50)
    expect(() => assembleAgentExecutionProfile({ override: { contextSafetyFraction: 0 } })).toThrow(
      '上下文安全余量必须大于 0 且小于 1'
    )
    expect(() => assembleAgentExecutionProfile({ override: { contextSafetyFraction: 1 } })).toThrow(
      '上下文安全余量必须大于 0 且小于 1'
    )
  })
})
