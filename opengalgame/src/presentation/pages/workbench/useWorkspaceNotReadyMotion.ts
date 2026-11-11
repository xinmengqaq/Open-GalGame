import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

/**
 * 未就绪构图只在状态切换时短入场。同屏最多一层缺失光在呼吸；
 * 减少动态效果时只做短淡入，不位移、不循环。
 */
export function useWorkspaceNotReadyMotion(
  root: RefObject<HTMLElement | null>,
  signature: string
): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const layers = node.querySelector('[data-motion="layers"]')
      const copy = node.querySelector('[data-motion="copy"]')
      const failure = node.querySelector('[data-motion="failure"]')
      const action = node.querySelector('[data-motion="action"]')
      const missing = node.querySelector('[data-motion="missing"]')
      const entering = [layers, copy, action].filter((item) => item !== null)
      if (prefersReducedMotion()) {
        gsap.fromTo(
          [...entering, failure].filter((item) => item !== null),
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.16,
            stagger: 0.02,
            onComplete: () => gsap.set(entering, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      const timeline = gsap.timeline()
      if (layers) {
        timeline.from(layers, { autoAlpha: 0, y: 10, duration: 0.32, ease: 'power2.out' })
      }
      if (copy) {
        timeline.from(copy, { autoAlpha: 0, duration: 0.24, ease: 'power2.out' }, '<0.06')
      }
      if (failure) {
        timeline.from(failure, { autoAlpha: 0, duration: 0.2, ease: 'power2.out' }, '<0.04')
      }
      if (action) {
        timeline.from(action, { autoAlpha: 0, duration: 0.22, ease: 'power2.out' }, '<0.04')
      }
      timeline.eventCallback('onComplete', () => {
        gsap.set(entering, { clearProps: 'transform,opacity,visibility' })
      })
      if (missing && signature !== 'rebuilding') {
        gsap.to(missing, {
          autoAlpha: 0.42,
          duration: 1.6,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut'
        })
      }
    },
    { scope: root, dependencies: [signature], revertOnUpdate: true }
  )
}
