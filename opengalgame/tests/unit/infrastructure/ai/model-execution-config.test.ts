import { describe, expect, it } from 'vitest'

import { assembleModelExecutionProfile } from '@infrastructure/ai/config/modelExecutionConfig'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const saved = {
  providerId: 'openai-compatible' as const,
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 200000,
  maxOutputTokens: 32000,
  temperature: undefined,
  topP: undefined,
  apiKey: 'stored-secret'
} satisfies ConnectionSettingsInfo

describe('模型执行配置组装', () => {
  it('沿用已保存的大输出上限，只在超时缺失时使用建议默认值', () => {
    const profile = assembleModelExecutionProfile({ saved })

    expect(profile).toEqual({
      providerId: 'openai-compatible',
      baseUrl: 'https://service.example/v1',
      model: 'chosen',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      requestTimeoutMs: 240000
    })
    expect(JSON.stringify(profile)).not.toContain('stored-secret')
    expect(profile).not.toHaveProperty('apiKey')
  })

  it('本次指定的合法输出上限和超时优先于已保存值与用户级超时', () => {
    const profile = assembleModelExecutionProfile({
      saved,
      user: { requestTimeoutMs: 180000 },
      override: { requestTimeoutMs: 60000, maxOutputTokens: 16000 }
    })

    expect(profile.maxOutputTokens).toBe(16000)
    expect(profile.requestTimeoutMs).toBe(60000)
    expect(profile.contextWindow).toBe(200000)
  })

  it('用户级超时在没有本次指定时生效', () => {
    expect(
      assembleModelExecutionProfile({ saved, user: { requestTimeoutMs: 180000 } }).requestTimeoutMs
    ).toBe(180000)
  })

  it('未配置采样时不写入温度或 top-p，已配置的 0 也会保留', () => {
    expect(assembleModelExecutionProfile({ saved })).not.toHaveProperty('temperature')
    expect(assembleModelExecutionProfile({ saved })).not.toHaveProperty('topP')
    expect(assembleModelExecutionProfile({ saved: { ...saved, temperature: 0 } }).temperature).toBe(
      0
    )
    expect(assembleModelExecutionProfile({ saved: { ...saved, topP: 1 } }).topP).toBe(1)
  })

  it('本次指定的同一采样参数覆盖已保存值', () => {
    expect(
      assembleModelExecutionProfile({
        saved: { ...saved, temperature: 0.2 },
        override: { temperature: 0.8 }
      })
    ).toMatchObject({ temperature: 0.8 })
  })

  it('输出上限可以等于较小的上下文窗口，不套用固定窗口', () => {
    const profile = assembleModelExecutionProfile({
      saved: { ...saved, contextWindow: 2048, maxOutputTokens: 2048 }
    })

    expect(profile.contextWindow).toBe(2048)
    expect(profile.maxOutputTokens).toBe(2048)
  })

  it.each([
    { override: { requestTimeoutMs: 0 }, message: '单次请求超时必须为正整数' },
    { override: { requestTimeoutMs: 1.5 }, message: '单次请求超时必须为正整数' },
    { override: { maxOutputTokens: 0 }, message: '最大输出 token 必须为正整数' },
    { override: { maxOutputTokens: 200001 }, message: '最大输出 token 不能超过上下文窗口' },
    { override: { temperature: -0.1 }, message: '温度必须为 0 到 1 之间的有限数值' },
    { override: { temperature: Number.NaN }, message: '温度必须为 0 到 1 之间的有限数值' },
    { override: { topP: 1.1 }, message: 'top-p 必须为 0 到 1 之间的有限数值' },
    {
      saved: { ...saved, contextWindow: 1.5 },
      message: '上下文窗口必须为正整数'
    }
  ])('显式非法参数失败，不用默认值吞掉：$message', ({ override, saved: nextSaved, message }) => {
    expect(() =>
      assembleModelExecutionProfile({ saved: nextSaved ?? saved, override })
    ).toThrowError(expect.objectContaining({ code: 1401, message }))
  })

  it('用户级非法超时不回退到建议默认值', () => {
    expect(() =>
      assembleModelExecutionProfile({ saved, user: { requestTimeoutMs: -1 } })
    ).toThrowError(expect.objectContaining({ code: 1401, message: '单次请求超时必须为正整数' }))
  })

  it('显式省略单次超时不回退建议值，也不写入有限哨兵', () => {
    const profile = assembleModelExecutionProfile({
      saved,
      user: { requestTimeoutMs: 180000 },
      override: { requestTimeoutMs: undefined, maxOutputTokens: 16000 }
    })

    expect(profile).not.toHaveProperty('requestTimeoutMs')
    expect(profile.maxOutputTokens).toBe(16000)
    expect(JSON.stringify(profile)).not.toContain('2147483647')
  })

  it('合并后同时存在温度和 top-p 时失败，不删除已保存值', () => {
    expect(() =>
      assembleModelExecutionProfile({
        saved: { ...saved, temperature: 0.4 },
        override: { topP: 0.2 }
      })
    ).toThrowError(expect.objectContaining({ code: 1401, message: '温度与 top-p 只能填写一个' }))
    expect(() =>
      assembleModelExecutionProfile({
        saved,
        override: { temperature: 0.2, topP: 0.3 }
      })
    ).toThrowError(expect.objectContaining({ code: 1401, message: '温度与 top-p 只能填写一个' }))
  })
})
