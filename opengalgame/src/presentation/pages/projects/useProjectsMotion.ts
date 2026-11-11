import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'
import type { ProjectsListStatus } from './useProjectsList'

/** 项目页首次成功列表的卡片入场。翻页不重播。 */
export function useProjectsMotion(
  root: RefObject<HTMLElement | null>,
  status: ProjectsListStatus
): void {
  const played = useRef(false)
  useGSAP(
    () => {
      const node = root.current
      if (!node || played.current) return
      if (status !== 'ready' && status !== 'empty') return
      const cards = node.querySelectorAll('[data-card-enter]')
      if (!cards.length) return
      played.current = true
      if (prefersReducedMotion()) {
        gsap.from(cards, { autoAlpha: 0, duration: 0.16 })
        return
      }
      gsap.from(cards, {
        y: 16,
        autoAlpha: 0,
        duration: 0.42,
        stagger: 0.04,
        ease: 'power2.out'
      })
    },
    { scope: root, dependencies: [status] }
  )
}
