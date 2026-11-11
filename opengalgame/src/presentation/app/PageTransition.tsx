import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type ReactElement, type ReactNode } from 'react'

import { prefersReducedMotion } from '../effects/motion'
import type { AppPage } from '../stores/navigation.store'
import styles from './PageTransition.module.css'

interface PageTransitionProps {
  page: AppPage
  children: ReactNode
}

export function PageTransition({ page, children }: PageTransitionProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useGSAP(
    () => {
      if (!ref.current) return
      const frame = ref.current
      const clearFrame = (): void => {
        gsap.set(frame, { clearProps: 'transform,opacity,visibility' })
      }
      const fromX = page === 'home' ? -40 : 40
      if (prefersReducedMotion()) {
        gsap.fromTo(
          frame,
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.16, onComplete: clearFrame }
        )
        return
      }
      gsap.fromTo(
        frame,
        { x: fromX, autoAlpha: 0 },
        { x: 0, autoAlpha: 1, duration: 0.31, ease: 'power2.out', onComplete: clearFrame }
      )
    },
    { dependencies: [page] }
  )
  return (
    <div ref={ref} className={styles.frame}>
      {children}
    </div>
  )
}
