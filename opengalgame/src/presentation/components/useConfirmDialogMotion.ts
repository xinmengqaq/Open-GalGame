import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '../effects/motion'

/**
 * 危险确认的入场：对象、说明、范围和风险依次出现。
 * 组件关闭时内容仍挂载，只在打开时播放；减少动态效果时只做短淡入。
 */
export function useConfirmDialogMotion(root: RefObject<HTMLElement | null>, open: boolean): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node || !open) return
      const target = node.querySelectorAll('[data-confirm-motion="target"]')
      const message = node.querySelectorAll('[data-confirm-motion="message"]')
      const scope = node.querySelectorAll('[data-confirm-motion="scope"]')
      const caveat = node.querySelectorAll('[data-confirm-motion="caveat"]')
      const targets = [...target, ...message, ...scope, ...caveat]
      if (targets.length === 0) return
      gsap.killTweensOf(targets)
      if (prefersReducedMotion()) {
        gsap.fromTo(
          targets,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            stagger: 0.015,
            onComplete: () => gsap.set(targets, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      const timeline = gsap.timeline()
      if (target.length > 0) {
        timeline.from(target, { y: 10, autoAlpha: 0, duration: 0.28, ease: 'power2.out' })
      }
      if (message.length > 0) {
        timeline.from(message, { y: 8, autoAlpha: 0, duration: 0.24, ease: 'power2.out' }, '<0.06')
      }
      if (scope.length > 0) {
        timeline.from(
          scope,
          { y: 8, autoAlpha: 0, duration: 0.24, stagger: 0.04, ease: 'power2.out' },
          '<0.05'
        )
      }
      if (caveat.length > 0) {
        timeline.from(
          caveat,
          { y: 8, scale: 0.985, autoAlpha: 0, duration: 0.28, ease: 'power2.out' },
          '<0.08'
        )
      }
      timeline.eventCallback('onComplete', () => {
        gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
      })
    },
    { scope: root, dependencies: [open] }
  )
}
