import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import type { RefObject } from 'react'

import { useNavigationStore } from '../../stores/navigation.store'

interface HomeMotionRefs {
  root: RefObject<HTMLElement | null>
  title1: RefObject<HTMLElement | null>
  title2: RefObject<HTMLElement | null>
  accent: RefObject<HTMLElement | null>
  hero: RefObject<HTMLElement | null>
  circle: RefObject<HTMLElement | null>
  speech: RefObject<HTMLElement | null>
  visual: RefObject<HTMLElement | null>
  importButton: RefObject<HTMLButtonElement | null>
  projectsButton: RefObject<HTMLButtonElement | null>
  createButton: RefObject<HTMLButtonElement | null>
  settingsButton: RefObject<HTMLButtonElement | null>
  downloadIcon: RefObject<SVGSVGElement | null>
  arrowIcon: RefObject<SVGSVGElement | null>
  plusIcon: RefObject<SVGSVGElement | null>
  gearIcon: RefObject<SVGSVGElement | null>
}

/**
 * 首页入场、入口反馈、视差与持续动态。图标只绕自身中心变换。
 * 首页长期挂载，减弱动效改由 matchMedia 承接，系统设置变更无需刷新即生效。
 * 实现思路：useGSAP 始终提供 contextSafe，非空断言只是与 gsap.context 共用签名的结果。
 */
export function useHomeMotion(refs: HomeMotionRefs): void {
  useGSAP(
    (_context, contextSafe) => {
      const root = refs.root.current
      if (!root) return
      const entries = root.querySelectorAll('[data-motion="entry"]')
      const chrome = root.querySelectorAll('[data-motion="chrome"]')
      const title1 = refs.title1.current
      const title2 = refs.title2.current
      const accent = refs.accent.current
      const hero = refs.hero.current
      const circle = refs.circle.current
      const speech = refs.speech.current
      const importButton = refs.importButton.current
      const projectsButton = refs.projectsButton.current
      const createButton = refs.createButton.current
      const settingsButton = refs.settingsButton.current
      const downloadIcon = refs.downloadIcon.current
      const downloadHead = downloadIcon?.querySelector('[data-download-head]')
      const arrowIcon = refs.arrowIcon.current
      const plusIcon = refs.plusIcon.current
      const gearIcon = refs.gearIcon.current
      const plusHalo = createButton?.querySelector('[data-plus-halo]')
      const listLines = projectsButton?.querySelectorAll('[data-list-line]') ?? []
      const safe = contextSafe!

      gsap.set([plusIcon, gearIcon, downloadIcon, arrowIcon], { transformOrigin: '50% 50%' })
      gsap.set(listLines, { transformOrigin: 'left center' })

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: reduce)', () => {
        if (useNavigationStore.getState().hasPlayedHomeIntro) return
        gsap.from([chrome, title1, title2, entries, hero, speech], {
          autoAlpha: 0,
          duration: 0.2
        })
        useNavigationStore.getState().markHomeIntroPlayed()
      })

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const { hasPlayedHomeIntro: played, markHomeIntroPlayed: markPlayed } =
          useNavigationStore.getState()
        if (!played) {
          gsap.set([title1, title2], { yPercent: 110, rotate: 3 })
          gsap.set(accent, { autoAlpha: 0, y: 12 })
          gsap.set(hero, { x: 72, scale: 1.04, autoAlpha: 0.85 })
          gsap.set(circle, { scale: 0.88 })
          gsap.set(entries, { y: 24, autoAlpha: 0 })
          gsap.set(speech, { rotate: 10, autoAlpha: 0 })
          gsap.set(chrome, { autoAlpha: 0 })
          const tl = gsap.timeline({ defaults: { ease: 'power3.out' }, onComplete: markPlayed })
          tl.to(chrome, { autoAlpha: 1, duration: 0.28 }, 0)
            .to(title1, { yPercent: 0, rotate: 0, duration: 0.55 }, 0.04)
            .to(title2, { yPercent: 0, rotate: 0, duration: 0.55 }, 0.12)
            .to(accent, { autoAlpha: 1, y: 0, duration: 0.35 }, 0.22)
            .to(hero, { x: 0, scale: 1, autoAlpha: 1, duration: 0.7 }, 0.08)
            .to(circle, { scale: 1, duration: 0.85 }, 0.12)
            .to(entries, { y: 0, autoAlpha: 1, duration: 0.4, stagger: 0.05 }, 0.16)
            .to(speech, { rotate: 6, autoAlpha: 1, duration: 0.45 }, 0.28)
            .to(
              speech,
              { rotate: 5.2, duration: 0.18, yoyo: true, repeat: 1, ease: 'sine.inOut' },
              0.7
            )
        }

        const listeners = new AbortController()
        const listenerOptions = { signal: listeners.signal }

        const onPrimaryEnter = safe(() => {
          gsap.to(importButton, { x: -2, y: -2, duration: 0.18, ease: 'power2.out' })
          gsap.to(arrowIcon, { x: 6, duration: 0.2, ease: 'power2.out' })
          if (downloadHead) {
            gsap.fromTo(
              downloadHead,
              { y: 0 },
              { y: 3, duration: 0.16, yoyo: true, repeat: 1, ease: 'power1.inOut' }
            )
          }
        })
        const onPrimaryLeave = safe(() => {
          gsap.to(importButton, { x: 0, y: 0, duration: 0.18 })
          gsap.to(arrowIcon, { x: 0, duration: 0.2 })
        })
        const onPrimaryDown = safe(() => {
          gsap.to(importButton, { x: 3, y: 3, duration: 0.08, ease: 'power2.in' })
        })
        const onListEnter = safe(() => {
          gsap.to(listLines, { x: 5, duration: 0.16, stagger: 0.05, ease: 'power2.out' })
        })
        const onListLeave = safe(() => {
          gsap.to(listLines, { x: 0, duration: 0.16, ease: 'power2.out' })
        })
        const onCreateEnter = safe(() => {
          gsap.to(plusIcon, {
            rotation: 90,
            duration: 0.28,
            ease: 'power2.out',
            transformOrigin: '50% 50%'
          })
          if (plusHalo) gsap.to(plusHalo, { scale: 1, duration: 0.28, ease: 'power2.out' })
        })
        const onCreateLeave = safe(() => {
          gsap.to(plusIcon, {
            rotation: 0,
            duration: 0.22,
            ease: 'power2.inOut',
            transformOrigin: '50% 50%'
          })
          if (plusHalo) gsap.to(plusHalo, { scale: 0, duration: 0.22, ease: 'power2.inOut' })
        })
        const onGearEnter = safe(() => {
          gsap.to(gearIcon, {
            rotation: 36,
            duration: 0.25,
            ease: 'power2.out',
            transformOrigin: '50% 50%'
          })
        })
        const onGearLeave = safe(() => {
          gsap.to(gearIcon, {
            rotation: 0,
            duration: 0.25,
            ease: 'power2.inOut',
            transformOrigin: '50% 50%'
          })
        })

        importButton?.addEventListener('pointerenter', onPrimaryEnter, listenerOptions)
        importButton?.addEventListener('pointerleave', onPrimaryLeave, listenerOptions)
        importButton?.addEventListener('pointerdown', onPrimaryDown, listenerOptions)
        importButton?.addEventListener('pointerup', onPrimaryEnter, listenerOptions)
        projectsButton?.addEventListener('pointerenter', onListEnter, listenerOptions)
        projectsButton?.addEventListener('pointerleave', onListLeave, listenerOptions)
        createButton?.addEventListener('pointerenter', onCreateEnter, listenerOptions)
        createButton?.addEventListener('pointerleave', onCreateLeave, listenerOptions)
        settingsButton?.addEventListener('pointerenter', onGearEnter, listenerOptions)
        settingsButton?.addEventListener('pointerleave', onGearLeave, listenerOptions)

        const visual = refs.visual.current
        const starA = root.querySelector('[data-parallax="star-a"]')
        const starB = root.querySelector('[data-parallax="star-b"]')
        if (visual) {
          const layers = [
            { el: circle, amp: 6 },
            { el: hero, amp: 12 },
            { el: starA, amp: 18 },
            { el: starB, amp: 18 }
          ].filter((layer) => layer.el)
          const movers = layers.map((layer) => ({
            x: gsap.quickTo(layer.el, 'x', { duration: 0.45, ease: 'power3' }),
            y: gsap.quickTo(layer.el, 'y', { duration: 0.45, ease: 'power3' }),
            amp: layer.amp
          }))
          const move = safe((event: PointerEvent) => {
            const box = visual.getBoundingClientRect()
            if (event.clientX < box.left) return
            const nx = ((event.clientX - box.left) / box.width - 0.5) * 2
            const ny = ((event.clientY - box.top) / box.height - 0.5) * 2
            movers.forEach((mover) => {
              mover.x(nx * mover.amp)
              mover.y(ny * mover.amp)
            })
          })
          const leave = safe(() => {
            movers.forEach((mover) => {
              mover.x(0)
              mover.y(0)
            })
          })
          root.addEventListener('pointermove', move, listenerOptions)
          root.addEventListener('pointerleave', leave, listenerOptions)
        }

        const idle = [
          gsap.to(starA, { rotation: 16, duration: 7, repeat: -1, yoyo: true, ease: 'sine.inOut' }),
          gsap.to(starB, {
            rotation: -20,
            duration: 9,
            repeat: -1,
            yoyo: true,
            ease: 'sine.inOut'
          })
        ]
        const onVisibility = (): void => {
          if (document.hidden) idle.forEach((tween) => tween.pause())
          else idle.forEach((tween) => tween.play())
        }
        document.addEventListener('visibilitychange', onVisibility, listenerOptions)

        return () => listeners.abort()
      })
    },
    { scope: refs.root }
  )
}
