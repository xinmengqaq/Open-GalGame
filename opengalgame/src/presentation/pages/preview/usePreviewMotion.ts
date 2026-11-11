import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

/**
 * 预览页进入和主状态切换：只做短淡入和轻位移，结束清掉内联 transform。
 * iframe 不参与补间，避免在舞台容器上留下 transform。
 */
export function usePreviewShellMotion(
  scope: RefObject<HTMLElement | null>,
  stateKey: string
): void {
  useGSAP(
    () => {
      const root = scope.current
      if (root === null) return
      const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-preview-motion]'))
      if (targets.length === 0) return

      if (prefersReducedMotion()) {
        gsap.from(targets, {
          opacity: 0,
          duration: 0.12,
          stagger: 0.02,
          clearProps: 'opacity,transform'
        })
        return
      }

      gsap.from(targets, {
        opacity: 0,
        y: 12,
        duration: 0.42,
        ease: 'power3.out',
        stagger: 0.055,
        clearProps: 'opacity,transform'
      })
    },
    { scope, dependencies: [stateKey], revertOnUpdate: true }
  )
}
