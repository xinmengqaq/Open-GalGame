import { describe, expect, it } from 'vitest'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { isAjaxResult } from '@interfaces/contracts/AjaxResultSchema'

describe('AjaxResult', () => {
  it('缺少数字 code 时不能当成成功', () => {
    expect(isAjaxResult({ msg: '操作成功' })).toBe(false)
    expect(isAjaxResult({ success: true })).toBe(false)
    expect(isAjaxResult({ code: '2000', msg: '操作成功' })).toBe(false)
    expect(isAjaxResult(null)).toBe(false)
  })

  it('取消是普通的成功结果', () => {
    const cancelled = {
      code: ErrorCodes.success,
      msg: '已取消选择',
      data: { status: 'cancelled' }
    }

    expect(isAjaxResult(cancelled)).toBe(true)
    expect(cancelled.code).toBe(2000)
  })
})
