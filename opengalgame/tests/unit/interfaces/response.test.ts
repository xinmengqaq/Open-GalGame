import { describe, expect, it } from 'vitest'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { isResponse } from '@interfaces/contracts/ResponseSchema'

describe('Response', () => {
  it('缺少数字 code 时不能当成成功', () => {
    expect(isResponse({ msg: '操作成功' })).toBe(false)
    expect(isResponse({ success: true })).toBe(false)
    expect(isResponse({ code: '2000', msg: '操作成功' })).toBe(false)
    expect(isResponse(null)).toBe(false)
  })

  it('取消是普通的成功结果', () => {
    const cancelled = {
      code: ErrorCodes.success,
      msg: '已取消选择',
      data: { status: 'cancelled' }
    }

    expect(isResponse(cancelled)).toBe(true)
    expect(cancelled.code).toBe(2000)
  })
})
