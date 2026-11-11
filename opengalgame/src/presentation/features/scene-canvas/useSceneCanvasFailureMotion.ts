import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useEffect, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

/**
 * 失败/损坏状态进入：印章落下、正文错峰出现，损坏态额外散开一圈警示光环。
 * 按钮按下、重试请求发出时给短反馈；减少动态效果时只保留短淡入。
 * 所有补间结束都清掉内联 transform/opacity，避免影响后续布局。
 */
export function useSceneCanvasFailureMotion(
  scope: RefObject<HTMLElement | null>,
  signature: string
): void {
  useGSAP(
    () => {
      const root = scope.current
      if (!root) return
      const reduced = prefersReducedMotion()
      const card = root.querySelector<HTMLElement>('[data-motion="failure-card"]')
      const seal = root.querySelector<HTMLElement>('[data-motion="failure-seal"]')
      const halo = root.querySelector<HTMLElement>('[data-motion="failure-halo"]')
      const reveals = root.querySelectorAll<HTMLElement>('[data-motion="failure-reveal"]')

      if (card) {
        gsap.fromTo(
          card,
          { autoAlpha: 0, y: reduced ? 0 : 14, scale: reduced ? 1 : 0.99 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: reduced ? 0.12 : 0.4,
            ease: 'power3.out',
            onComplete: () => gsap.set(card, { clearProps: 'transform,opacity,visibility' })
          }
        )
      }

      if (seal) {
        gsap.fromTo(
          seal,
          { autoAlpha: 0, rotate: reduced ? 0 : -8, scale: reduced ? 1 : 0.72 },
          {
            autoAlpha: 1,
            rotate: 0,
            scale: 1,
            duration: reduced ? 0.12 : 0.44,
            ease: reduced ? 'power1.out' : 'back.out(1.6)',
            onComplete: () => gsap.set(seal, { clearProps: 'transform,opacity,visibility' })
          }
        )
      }

      if (reveals.length > 0) {
        gsap.fromTo(
          reveals,
          { autoAlpha: 0, y: reduced ? 0 : 10 },
          {
            autoAlpha: 1,
            y: 0,
            duration: reduced ? 0.12 : 0.32,
            stagger: reduced ? 0.015 : 0.055,
            ease: 'power2.out',
            onComplete: () => gsap.set(reveals, { clearProps: 'transform,opacity,visibility' })
          }
        )
      }

      if (halo && !reduced) {
        gsap.fromTo(
          halo,
          { autoAlpha: 0.55, scale: 0.72 },
          {
            autoAlpha: 0,
            scale: 1.7,
            duration: 1.15,
            ease: 'power2.out',
            onComplete: () => gsap.set(halo, { clearProps: 'transform,opacity,visibility' })
          }
        )
      }
    },
    { scope, dependencies: [signature], revertOnUpdate: true }
  )

  useEffect(() => {
    const root = scope.current
    if (!root) return
    const buttons = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-motion="state-action"], [data-motion="retry-action"]'
      )
    )
    const cleanups = buttons.map((button) => {
      const press = (): void => {
        if (prefersReducedMotion()) return
        gsap.killTweensOf(button)
        gsap.to(button, { scale: 0.975, duration: 0.08, ease: 'power2.out' })
      }
      const release = (): void => {
        gsap.to(button, {
          scale: 1,
          duration: 0.18,
          ease: 'power2.out',
          onComplete: () => gsap.set(button, { clearProps: 'transform' })
        })
      }
      const confirm = (): void => {
        if (prefersReducedMotion()) return
        if (button.dataset.motion === 'retry-action') {
          const scan = root.querySelector<HTMLElement>('[data-motion="retry-feedback"]')
          if (scan) {
            gsap.fromTo(
              scan,
              { autoAlpha: 0.85, scaleX: 0, transformOrigin: 'left center' },
              {
                autoAlpha: 0,
                scaleX: 1,
                duration: 0.7,
                ease: 'power2.inOut',
                onComplete: () => gsap.set(scan, { clearProps: 'transform,opacity,visibility' })
              }
            )
          }
        }
        const icon = button.querySelector<SVGElement>('svg')
        if (!icon) return
        gsap.fromTo(
          icon,
          { x: 0 },
          {
            x: 3,
            duration: 0.12,
            yoyo: true,
            repeat: 1,
            ease: 'power1.inOut',
            onComplete: () => gsap.set(icon, { clearProps: 'transform' })
          }
        )
      }

      button.addEventListener('pointerdown', press)
      button.addEventListener('pointerup', release)
      button.addEventListener('pointercancel', release)
      button.addEventListener('pointerleave', release)
      button.addEventListener('click', confirm)
      return () => {
        button.removeEventListener('pointerdown', press)
        button.removeEventListener('pointerup', release)
        button.removeEventListener('pointercancel', release)
        button.removeEventListener('pointerleave', release)
        button.removeEventListener('click', confirm)
        gsap.killTweensOf(button)
        gsap.set(button, { clearProps: 'transform' })
      }
    })

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [scope, signature])
}
