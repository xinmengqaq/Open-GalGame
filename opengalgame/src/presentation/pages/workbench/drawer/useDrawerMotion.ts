import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

type DrawerMotionOptions = {
  tab: string
}

/**
 * 抽屉壳的入场和标签切换动效。Radix Sheet 负责滑入滑出，这里只编排头部
 * 与当前面板的淡入，避免和模态动画叠加。减少动态效果时只做短淡入。
 */
export function useDrawerMotion(
  root: RefObject<HTMLElement | null>,
  { tab }: DrawerMotionOptions
): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const header = node.querySelectorAll('[data-drawer-motion="header"]')
      const view = node.querySelectorAll(
        '.wb-drawer__view[data-state="active"] [data-drawer-motion="view"]'
      )
      const targets = [...header, ...view]
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
        { y: 10, autoAlpha: 0 },
        {
          y: 0,
          autoAlpha: 1,
          duration: 0.3,
          stagger: 0.04,
          ease: 'power2.out',
          onComplete: () => gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope: root, dependencies: [tab] }
  )
}
