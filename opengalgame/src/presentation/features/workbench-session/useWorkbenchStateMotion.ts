import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

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
