import { describe, expect, it } from 'vitest'

import {
  isArrangementUnreadable,
  isOwnershipMismatch
} from '@presentation/feedback/projectFilesFeedback'

describe('工作台反馈', () => {
  it('用错误码判断归属不匹配和画布损坏，不读消息文本', () => {
    expect(isOwnershipMismatch(4319)).toBe(true)
    expect(isOwnershipMismatch(4314)).toBe(false)
    expect(isArrangementUnreadable(4314)).toBe(true)
    expect(isArrangementUnreadable(4315)).toBe(true)
    expect(isArrangementUnreadable(4317)).toBe(true)
    expect(isArrangementUnreadable(2000)).toBe(false)
  })
})
