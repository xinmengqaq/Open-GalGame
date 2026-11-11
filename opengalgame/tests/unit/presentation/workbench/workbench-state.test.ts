import { describe, expect, it } from 'vitest'

import { workbenchStateOf } from '@presentation/features/workbench-session/workbenchState'

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
