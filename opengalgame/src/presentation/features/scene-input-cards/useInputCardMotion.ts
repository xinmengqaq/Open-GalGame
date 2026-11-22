import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

export function useCardEntranceMotion(scope: RefObject<HTMLElement | null>): void {
  useGSAP(
    () => {
      const element = scope.current
      if (!element) return
      const reduced = prefersReducedMotion()
      gsap.from(element, {
        autoAlpha: 0,
        y: reduced ? 0 : 14,
        scale: reduced ? 1 : 0.985,
        duration: reduced ? 0.12 : 0.42,
        ease: 'power3.out',
        onComplete: () => gsap.set(element, { clearProps: 'transform,opacity,visibility' })
      })
    },
    { scope }
  )
}

export function useCardFrameMotion(scope: RefObject<HTMLElement | null>, selected: boolean): void {
  useGSAP(
    () => {
      const seal = scope.current?.querySelector<HTMLElement>('[data-motion="card-seal"]')
      if (!seal) return
      const reduced = prefersReducedMotion()
      if (!selected) {
        gsap.to(seal, {
          autoAlpha: 0,
          duration: reduced ? 0.08 : 0.16,
          ease: 'power2.out',
          onComplete: () => gsap.set(seal, { clearProps: 'transform,opacity,visibility' })
        })
        return
      }
      gsap.fromTo(
        seal,
        { autoAlpha: 0, y: reduced ? 0 : -4, scaleX: reduced ? 1 : 0.6 },
        {
          autoAlpha: 1,
          y: 0,
          scaleX: 1,
          duration: reduced ? 0.12 : 0.22,
          ease: 'power2.out',
          onComplete: () => gsap.set(seal, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope, dependencies: [selected], revertOnUpdate: true }
  )
}

export function usePresetErrorMotion(scope: RefObject<HTMLElement | null>, errorKey: number): void {
  useGSAP(
    () => {
      if (errorKey === 0) return
      const element = scope.current?.querySelector<HTMLElement>('[data-motion="preset-error"]')
      if (!element) return
      const reduced = prefersReducedMotion()
      gsap.fromTo(
        element,
        { autoAlpha: 0, y: reduced ? 0 : 6 },
        {
          autoAlpha: 1,
          y: 0,
          duration: reduced ? 0.12 : 0.3,
          ease: 'power2.out',
          onComplete: () => gsap.set(element, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope, dependencies: [errorKey], revertOnUpdate: true }
  )
}

export function usePresetPreviewMotion(
  scope: RefObject<HTMLElement | null>,
  presetKey: string
): void {
  useGSAP(
    () => {
      const element = scope.current?.querySelector<HTMLElement>('[data-preset-emblem]')
      if (!element) return
      const reduced = prefersReducedMotion()
      gsap.fromTo(
        element,
        { autoAlpha: 0, y: reduced ? 0 : 7, scale: reduced ? 1 : 0.94 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: reduced ? 0.12 : 0.36,
          ease: 'power2.out',
          onComplete: () => gsap.set(element, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope, dependencies: [presetKey], revertOnUpdate: true }
  )
}

export function usePromptFocusMotion(scope: RefObject<HTMLElement | null>, focused: boolean): void {
  useGSAP(
    () => {
      const halo = scope.current?.querySelector<HTMLElement>('[data-prompt-halo]')
      if (!halo) return
      const reduced = prefersReducedMotion()
      if (!focused) {
        gsap.to(halo, {
          autoAlpha: 0,
          duration: reduced ? 0.06 : 0.12,
          ease: 'power2.out',
          onComplete: () => gsap.set(halo, { clearProps: 'transform,opacity,visibility' })
        })
        return
      }
      gsap.fromTo(
        halo,
        { autoAlpha: 0, scale: 0.96 },
        {
          autoAlpha: 0.72,
          scale: 1,
          duration: reduced ? 0.08 : 0.22,
          yoyo: true,
          repeat: 1,
          repeatDelay: 0.04,
          ease: 'power2.out',
          onComplete: () => gsap.set(halo, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope, dependencies: [focused], revertOnUpdate: true }
  )
}
