import { afterEach, expect, it, vi } from 'vitest'

import { scheduleLongTimeout } from '@common/longTimeout'

afterEach(() => {
  vi.useRealTimers()
})

it('超过平台最大延迟的期限分段安排，取消后不再触发', () => {
  vi.useFakeTimers()
  const fire = vi.fn()
  const cancel = scheduleLongTimeout(2_147_483_648, fire)

  vi.advanceTimersByTime(2_147_483_647)
  expect(fire).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(fire).toHaveBeenCalledTimes(1)

  const cancelled = scheduleLongTimeout(2_147_483_648, fire)
  cancelled()
  vi.advanceTimersByTime(2_147_483_648)
  expect(fire).toHaveBeenCalledTimes(1)
  cancel()
})
