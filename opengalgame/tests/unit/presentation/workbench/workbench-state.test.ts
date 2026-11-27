import { describe, expect, it } from 'vitest'

import {
  arrangementStateOf,
  catalogStateOf,
  isDamagedFailureCode,
  workbenchStateOf
} from '@presentation/features/workbench-session/workbenchState'

const loaded = {
  catalogStatus: 'ready' as const,
  catalogError: null,
  arrangementError: null
}

describe('工作台顶栏状态', () => {
  it('empty 但已有卡片时显示就绪，ready 但没有卡片时显示空画布', () => {
    expect(
      workbenchStateOf({
        ...loaded,
        arrangementStatus: 'empty',
        arrangementCardCount: 2
      }).kind
    ).toBe('ready')
    expect(
      workbenchStateOf({
        ...loaded,
        arrangementStatus: 'ready',
        arrangementCardCount: 0
      }).title
    ).toBe('画布还没有卡片')
  })

  it('读取中和失败不被卡片数覆盖', () => {
    expect(
      workbenchStateOf({
        ...loaded,
        arrangementStatus: 'loading',
        arrangementCardCount: 3
      }).kind
    ).toBe('reading')
    expect(
      workbenchStateOf({
        ...loaded,
        arrangementStatus: 'failed',
        arrangementError: { code: 4416, msg: '编排内容损坏' },
        arrangementCardCount: 3
      }).kind
    ).toBe('damaged')
  })
})

describe('R18 工作台损坏与读取失败冻结', () => {
  it('4416/4417 在画布和来源目录上都按损坏显示，数值与可见文案不变', () => {
    const damaged = arrangementStateOf('failed', { code: 4416, msg: '编排内容损坏' })
    expect(damaged).toMatchObject({
      kind: 'damaged',
      scope: 'arrangement',
      tone: 'danger',
      subject: '画布编排',
      title: '画布编排内容损坏',
      detail: '编排内容损坏',
      failureCode: 4416
    })
    expect(damaged.nextStep).toBe('检查工程诊断，确认损坏范围。')
    expect(damaged.actions).toEqual([{ intent: 'inspect', label: '检查工程', emphasis: 'primary' }])

    const unsupported = arrangementStateOf('failed', { code: 4417, msg: '编排格式不受支持' })
    expect(unsupported).toMatchObject({
      kind: 'damaged',
      title: '画布编排格式不受支持',
      failureCode: 4417
    })

    expect(catalogStateOf('failed', { code: 4416, msg: '编排内容损坏' })).toMatchObject({
      kind: 'damaged',
      scope: 'catalog',
      title: '来源目录内容损坏',
      failureCode: 4416
    })
    expect(catalogStateOf('failed', { code: 4417, msg: '编排格式不受支持' }).title).toBe(
      '来源目录格式不受支持'
    )
  })

  it('工程文件损坏码 4314/4315 沿用同一损坏判定，4401/4402 仍是读取失败', () => {
    expect(catalogStateOf('failed', { code: 4314, msg: '来源内容损坏' }).title).toBe(
      '来源目录内容损坏'
    )
    expect(arrangementStateOf('failed', { code: 4315, msg: '来源格式不受支持' }).title).toBe(
      '画布编排格式不受支持'
    )

    for (const code of [4401, 4402, 4411]) {
      expect(arrangementStateOf('failed', { code, msg: '画布校验失败' })).toMatchObject({
        kind: 'read-failed',
        title: '画布编排读取失败',
        detail: '画布校验失败',
        failureCode: code
      })
    }
  })

  it('isDamagedFailureCode 只认 4416/4417 与 4314/4315', () => {
    expect([4416, 4417, 4314, 4315].map((code) => isDamagedFailureCode(code))).toEqual([
      true,
      true,
      true,
      true
    ])
    expect([4401, 4402, 4411, 5102].map((code) => isDamagedFailureCode(code))).toEqual([
      false,
      false,
      false,
      false
    ])
    expect(isDamagedFailureCode(null)).toBe(false)
    expect(isDamagedFailureCode(undefined)).toBe(false)
  })
})
