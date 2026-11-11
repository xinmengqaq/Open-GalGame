import gsap from 'gsap'
import { useEffect, useRef, type ReactElement } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

const formatter = new Intl.NumberFormat('zh-CN')

/**
 * 统计数字变化用滚动数字反馈；减少动态效果时直接替换文本。
 * 只写 textContent，结束后不残留内联样式。
 */
export function CountUp({ value }: { value: number }): ReactElement {
  const node = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const element = node.current
    if (!element) return
    if (prefersReducedMotion()) {
      element.textContent = formatter.format(value)
      return
    }
    const proxy = { current: Number(element.dataset.value ?? value) }
    const tween = gsap.to(proxy, {
      current: value,
      duration: 0.6,
      ease: 'power2.out',
      onUpdate: () => {
        element.textContent = formatter.format(Math.round(proxy.current))
      },
      onComplete: () => {
        element.textContent = formatter.format(value)
        element.dataset.value = String(value)
      }
    })
    return () => {
      tween.kill()
    }
  }, [value])

  return (
    <span ref={node} data-value={value}>
      {formatter.format(value)}
    </span>
  )
}
