import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../effects/motion'

export function useSourceStatusMotion(
  scope: RefObject<HTMLElement | null>,
  statusKey: string,
  enabled: boolean
): void {
  const lastKey = useRef<string | null>(null)

  useGSAP(
    () => {
      const element = scope.current
      const first = lastKey.current === null
      lastKey.current = statusKey
      if (!element || !enabled || first) return
      const reduced = prefersReducedMotion()
      const risky = statusKey.startsWith('disconnected') || statusKey.startsWith('unreadable')
      gsap.fromTo(
        element,
        { autoAlpha: 0, y: reduced ? 0 : -3 },
        {
          autoAlpha: 1,
          y: 0,
          duration: reduced ? 0.12 : 0.28,
          ease: 'power2.out',
          onComplete: () => gsap.set(element, { clearProps: 'transform,opacity,visibility' })
        }
      )
      if (!risky || reduced) return
      const icon = element.querySelector<HTMLElement>('[data-motion="source-status-icon"]')
      if (!icon) return
      gsap.fromTo(
        icon,
        { rotate: -9 },
        {
          rotate: 0,
          duration: 0.4,
          delay: 0.06,
          ease: 'elastic.out(1, 0.45)',
          onComplete: () => gsap.set(icon, { clearProps: 'transform' })
        }
      )
    },
    { scope, dependencies: [statusKey, enabled], revertOnUpdate: true }
  )
}
