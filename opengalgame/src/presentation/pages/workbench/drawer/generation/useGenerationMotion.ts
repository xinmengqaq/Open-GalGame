import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

type GenerationMotionOptions = {
  phase: string
  view: string
  interactionId: string | null
}

/**
 * 生成面板的入场编排：空态构图层叠淡入、消息按序入场、新交互换页。
 * 只做一次性位移和淡入，没有循环补间；减少动态效果时收敛为短淡入。
 */
export function useGenerationMotion(
  root: RefObject<HTMLElement | null>,
  { phase, view, interactionId }: GenerationMotionOptions
): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const messageTargets = node.querySelectorAll('[data-gen-motion="message"]')
      const heroTargets = node.querySelectorAll(
        '[data-gen-motion="hero"], [data-gen-motion="copy"], [data-gen-motion="actions"]'
      )
      const targets = phase === 'empty' ? heroTargets : messageTargets
      if (targets.length === 0) return
      gsap.killTweensOf(targets)
      if (prefersReducedMotion()) {
        gsap.fromTo(
          targets,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.14,
            stagger: 0.02,
            onComplete: () => gsap.set(targets, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        targets,
        { autoAlpha: 0, y: 12 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.34,
          stagger: 0.045,
          ease: 'power2.out',
          onComplete: () => gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope: root, dependencies: [phase, view, interactionId] }
  )
}
