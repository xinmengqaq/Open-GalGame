/** Node 与浏览器都把超过 32 位有符号整数上限的 setTimeout 延迟当作 0（立即触发）。 */
const maximumTimerDelayMs = 2_147_483_647

/**
 * 安排可能超过平台最大延迟的计时器：按最大段长重新挂起，累计到期后再触发。
 * 不改变调用方给出的期限；取消后不再触发，也不保留计时器。
 * @param delayMs - 总延迟毫秒。非有限或负数按 0 处理。
 * @param fire - 到期回调；只调用一次。
 * @returns 取消函数。
 */
export function scheduleLongTimeout(delayMs: number, fire: () => void): () => void {
  let remaining = Number.isFinite(delayMs) ? Math.max(0, delayMs) : maximumTimerDelayMs
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = (): void => {
    if (cancelled) return
    if (remaining <= maximumTimerDelayMs) {
      timer = setTimeout(fire, remaining)
      return
    }
    remaining -= maximumTimerDelayMs
    timer = setTimeout(arm, maximumTimerDelayMs)
  }

  arm()
  return () => {
    cancelled = true
    clearTimeout(timer)
    timer = undefined
  }
}
