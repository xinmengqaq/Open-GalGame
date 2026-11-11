import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

/**
 * 顶栏状态变化时提示“对象/状态/下一步”换了一组，不做常驻抖动。
 * 减少动态效果时只做短淡入，结束后清掉内联 transform 和透明度。
 */
export function useWorkbenchStateMotion(
  scope: RefObject<HTMLElement | null>,
  signature: string
): void {
  const firstRender = useRef(true)

  useGSAP(
    () => {
      const root = scope.current
      if (!root) return
      const reduced = prefersReducedMotion()
      const first = firstRender.current
      firstRender.current = false
      gsap.fromTo(
        root,
        { autoAlpha: 0, y: reduced ? 0 : first ? 3 : -3 },
        {
          autoAlpha: 1,
          y: 0,
          duration: reduced ? 0.1 : first ? 0.3 : 0.22,
          ease: 'power2.out',
          onComplete: () => gsap.set(root, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope, dependencies: [signature], revertOnUpdate: true }
  )
}
