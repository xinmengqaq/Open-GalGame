import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useEffect, useState, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

export function useProjectMenuMotion(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean
): { rendered: boolean } {
  const [rendered, setRendered] = useState(open)

  if (open && !rendered) {
    setRendered(true)
  }

  useEffect(() => {
    if (open || !rendered) return
    const panel = panelRef.current
    if (!panel) {
      setRendered(false)
      return
    }
    const reduced = prefersReducedMotion()
    gsap.killTweensOf(panel)
    const tween = gsap.to(panel, {
      opacity: 0,
      duration: reduced ? 0.08 : 0.13,
      ease: 'power1.in',
      onComplete: () => {
        gsap.set(panel, { clearProps: 'opacity' })
        setRendered(false)
      }
    })
    return () => {
      tween.kill()
    }
  }, [open, panelRef, rendered])

  useGSAP(
    () => {
      if (!open || !rendered) return
      const panel = panelRef.current
      if (!panel) return
      const reduced = prefersReducedMotion()
      gsap.killTweensOf(panel)
      const items = panel.querySelectorAll('[role="menuitem"]')
      const timeline = gsap.timeline()
      timeline.fromTo(
        panel,
        { opacity: 0 },
        {
          opacity: 1,
          duration: reduced ? 0.1 : 0.2,
          ease: 'power2.out',
          onComplete: () => gsap.set(panel, { clearProps: 'opacity' })
        }
      )
      if (!reduced && items.length) {
        timeline.fromTo(
          items,
          { opacity: 0 },
          {
            opacity: 1,
            duration: 0.16,
            stagger: 0.035,
            ease: 'power2.out',
            clearProps: 'opacity'
          },
          0.04
        )
      }
    },
    { dependencies: [open, rendered] }
  )

  return { rendered }
}
