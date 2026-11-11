import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useCallback, useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

type DocumentLayerMotion = {
  overlayRef: RefObject<HTMLDivElement | null>
  sheetRef: RefObject<HTMLDivElement | null>
  closeWithMotion: (onClosed: () => void) => void
}

/** 文档层滑入与淡出。减少动态效果时只短淡入，关闭后清除内联样式。 */
export function useDocumentLayerMotion(cardId: string | null): DocumentLayerMotion {
  const overlayRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const closing = useRef(false)

  useGSAP(
    () => {
      const overlay = overlayRef.current
      const sheet = sheetRef.current
      if (!overlay || !sheet) return
      closing.current = false
      const reduced = prefersReducedMotion()
      gsap.fromTo(
        overlay,
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: reduced ? 0.12 : 0.24,
          onComplete: () => {
            if (!closing.current) gsap.set(overlay, { clearProps: 'opacity,visibility' })
          }
        }
      )
      gsap.fromTo(
        sheet,
        { autoAlpha: 0, y: reduced ? 0 : 28, scale: reduced ? 1 : 0.988 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: reduced ? 0.14 : 0.38,
          ease: 'power3.out',
          onComplete: () => {
            if (!closing.current) gsap.set(sheet, { clearProps: 'transform,opacity,visibility' })
          }
        }
      )
    },
    { scope: overlayRef, dependencies: [cardId], revertOnUpdate: true }
  )

  const closeWithMotion = useCallback((onClosed: () => void) => {
    if (closing.current) return
    closing.current = true
    const overlay = overlayRef.current
    const sheet = sheetRef.current
    if (!overlay || !sheet) {
      onClosed()
      return
    }
    const reduced = prefersReducedMotion()
    gsap.to(sheet, {
      autoAlpha: 0,
      y: reduced ? 0 : 18,
      duration: reduced ? 0.1 : 0.2,
      ease: 'power2.in'
    })
    gsap.to(overlay, {
      autoAlpha: 0,
      duration: reduced ? 0.12 : 0.22,
      ease: 'power2.in',
      onComplete: onClosed
    })
  }, [])

  return { overlayRef, sheetRef, closeWithMotion }
}
