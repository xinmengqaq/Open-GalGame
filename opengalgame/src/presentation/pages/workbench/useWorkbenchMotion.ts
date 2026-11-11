import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

/**
 * 工作台入场：顶栏、文件区、画布依次出现。
 * 减少动态效果时只做短淡入；结束后清掉内联样式，避免影响布局与拖拽。
 */
export function useWorkbenchMotion(root: RefObject<HTMLElement | null>): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const chrome = node.querySelectorAll('[data-motion="chrome"]')
      const panel = node.querySelectorAll('[data-motion="panel"]')
      const stage = node.querySelectorAll('[data-motion="stage"]')
      const save = node.querySelectorAll('[data-motion="save"]')
      const all = [...chrome, ...panel, ...stage, ...save]
      if (all.length === 0) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          all,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.16,
            stagger: 0.03,
            onComplete: () => gsap.set(all, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      const timeline = gsap.timeline()
      timeline
        .from(chrome, { y: -14, autoAlpha: 0, duration: 0.34, ease: 'power2.out' })
        .from(save, { y: -6, autoAlpha: 0, duration: 0.28, ease: 'power2.out' }, '<0.06')
        .from(panel, { x: -22, autoAlpha: 0, duration: 0.42, ease: 'power3.out' }, '<0.04')
        .from(
          stage,
          {
            y: 18,
            scale: 0.992,
            autoAlpha: 0,
            transformOrigin: '50% 0%',
            duration: 0.46,
            ease: 'power3.out'
          },
          '<0.02'
        )
        .eventCallback('onComplete', () => {
          gsap.set(all, { clearProps: 'transform,opacity,visibility' })
        })
    },
    { scope: root }
  )
}
