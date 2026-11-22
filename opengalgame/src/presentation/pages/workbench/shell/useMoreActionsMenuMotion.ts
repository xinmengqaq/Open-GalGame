import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useEffect, useState, type RefObject } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

export function useMoreActionsMenuMotion(
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
      autoAlpha: 0,
      y: reduced ? 0 : -4,
      duration: reduced ? 0.08 : 0.13,
      ease: 'power1.in',
      onComplete: () => {
        gsap.set(panel, { clearProps: 'transform,opacity,visibility' })
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
      gsap.fromTo(
        panel,
        { autoAlpha: 0, y: reduced ? 0 : -6, scale: reduced ? 1 : 0.985 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: reduced ? 0.1 : 0.2,
          ease: 'power2.out',
          onComplete: () => gsap.set(panel, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { dependencies: [open, rendered] }
  )

  return { rendered }
}
