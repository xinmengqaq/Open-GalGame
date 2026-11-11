import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

type VersionHistoryMotionOptions = {
  status: string
  filter: string
  resetToken: number
  expandedKey: string
  selectedId: string | null
}

/**
 * 作品历史动效：时间线主轴绘制、日期与条目错落入场、自动保存组展开、
 * 详情展开入场。减少动态效果时只短淡入，结束后清掉内联变换。
 */
export function useVersionHistoryMotion(
  root: RefObject<HTMLElement | null>,
  options: VersionHistoryMotionOptions
): void {
  useGSAP(
    () => {
      const node = root.current
      if (!node || options.status !== 'ready') return
      const spine = node.querySelectorAll('.works-spine__line')
      const dates = node.querySelectorAll('[data-works-motion="date"]')
      const rows = node.querySelectorAll('[data-works-motion="row"]')
      const targets = [...spine, ...dates, ...rows]
      if (targets.length === 0) return
      gsap.killTweensOf(targets)
      if (prefersReducedMotion()) {
        gsap.fromTo(
          targets,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.14,
            stagger: 0.012,
            onComplete: () => gsap.set(targets, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      const timeline = gsap.timeline()
      if (spine.length > 0) {
        timeline.fromTo(
          spine,
          { strokeDasharray: 1000, strokeDashoffset: 1000 },
          {
            strokeDashoffset: 0,
            duration: 0.22,
            ease: 'power2.out',
            onComplete: () => gsap.set(spine, { clearProps: 'strokeDasharray,strokeDashoffset' })
          }
        )
      }
      if (dates.length > 0) {
        timeline.from(
          dates,
          { y: 8, autoAlpha: 0, duration: 0.24, stagger: 0.03, ease: 'power2.out' },
          '<0.02'
        )
      }
      if (rows.length > 0) {
        timeline.from(
          rows,
          { y: 10, autoAlpha: 0, duration: 0.28, stagger: 0.03, ease: 'power2.out' },
          '<0.02'
        )
      }
      timeline.eventCallback('onComplete', () => {
        gsap.set(targets, { clearProps: 'transform,opacity,visibility' })
      })
    },
    {
      scope: root,
      dependencies: [options.status, options.filter, options.resetToken]
    }
  )

  useGSAP(
    () => {
      const node = root.current
      if (!node || options.expandedKey === '') return
      const rows = node.querySelectorAll('[data-works-motion="subrow"]')
      if (rows.length === 0) return
      gsap.killTweensOf(rows)
      if (prefersReducedMotion()) {
        gsap.fromTo(
          rows,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.14,
            stagger: 0.02,
            onComplete: () => gsap.set(rows, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        rows,
        { y: 8, autoAlpha: 0 },
        {
          y: 0,
          autoAlpha: 1,
          duration: 0.28,
          stagger: 0.035,
          ease: 'power2.out',
          onComplete: () => gsap.set(rows, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope: root, dependencies: [options.expandedKey] }
  )

  useGSAP(
    () => {
      const node = root.current
      if (!node || options.selectedId === null) return
      const detail = node.querySelector('[data-works-motion="detail"]')
      if (!detail) return
      gsap.killTweensOf(detail)
      if (prefersReducedMotion()) {
        gsap.fromTo(
          detail,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            onComplete: () => gsap.set(detail, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        detail,
        { y: 12, autoAlpha: 0 },
        {
          y: 0,
          autoAlpha: 1,
          duration: 0.28,
          ease: 'power3.out',
          onComplete: () => gsap.set(detail, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope: root, dependencies: [options.selectedId] }
  )
}
