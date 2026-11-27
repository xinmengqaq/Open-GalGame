import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

export function useAppUpdateMotion(root: RefObject<HTMLElement | null>, kind: string): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const targets = [
        node.querySelector('[data-update-motion="hero"]'),
        node.querySelector('[data-update-motion="action"]')
      ].filter((target): target is Element => target !== null)
      if (targets.length === 0) return
      const clear = (): void => {
        gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
      }
      if (prefersReducedMotion()) {
        gsap.fromTo(targets, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12, onComplete: clear })
        return
      }
      gsap.fromTo(
        targets,
        { autoAlpha: 0, y: 6 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.24,
          stagger: 0.03,
          ease: 'power2.out',
          onComplete: clear
        }
      )
    },
    { scope: root, dependencies: [kind] }
  )
}
