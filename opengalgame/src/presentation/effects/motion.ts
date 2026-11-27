export type EffectiveReducedMotion = 'reduce' | 'full'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** 根元素上的有效动效状态优先；外观设置尚未应用时回退系统偏好。 */
export function effectiveReducedMotion(): EffectiveReducedMotion {
  if (typeof document !== 'undefined') {
    const explicit = document.documentElement.dataset.reducedMotion
    if (explicit === 'reduce' || explicit === 'full') return explicit
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches ? 'reduce' : 'full'
  }
  return 'full'
}

export const prefersReducedMotion = (): boolean => effectiveReducedMotion() === 'reduce'

/**
 * 订阅有效动效状态。根上的 data-reduced-motion 由外观设置维护：
 * system 模式由外观层随系统偏好重写，on/off 固定为 reduce/full。
 * 只有有效状态真正变化时才回调，避免系统变化穿透显式选择。
 */
export function subscribeReducedMotion(listener: (reduced: boolean) => void): () => void {
  let current = prefersReducedMotion()
  let media: MediaQueryList | null = null
  let observer: MutationObserver | null = null

  const check = (): void => {
    const next = prefersReducedMotion()
    if (next === current) return
    current = next
    listener(next)
  }

  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(check)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-reduced-motion']
    })
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    media = window.matchMedia(REDUCED_MOTION_QUERY)
    media.addEventListener?.('change', check)
  }

  return () => {
    observer?.disconnect()
    media?.removeEventListener?.('change', check)
  }
}
