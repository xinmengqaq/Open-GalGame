import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useLayoutEffect, useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

export function useCatalogRowsMotion(
  scope: RefObject<HTMLElement | null>,
  signature: string
): void {
  useGSAP(
    () => {
      const root = scope.current
      if (!root) return
      const nodes = root.querySelectorAll<HTMLElement>('[data-catalog-animate]')
      if (nodes.length === 0) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          nodes,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            stagger: 0.012,
            onComplete: () => gsap.set(nodes, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        nodes,
        { autoAlpha: 0, y: 9 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.26,
          stagger: 0.024,
          ease: 'power2.out',
          onComplete: () => gsap.set(nodes, { clearProps: 'opacity,visibility,transform' })
        }
      )
    },
    { dependencies: [signature], scope, revertOnUpdate: true }
  )
}

export function useFolderExpandMotion(scope: RefObject<HTMLElement | null>): void {
  useGSAP(
    () => {
      const node = scope.current
      if (!node) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          node,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      const rows = node.querySelectorAll<HTMLElement>(':scope > li')
      gsap.fromTo(
        node,
        { height: 0, autoAlpha: 0 },
        {
          height: 'auto',
          autoAlpha: 1,
          duration: 0.3,
          ease: 'power2.out',
          onComplete: () => gsap.set(node, { clearProps: 'height,opacity,visibility' })
        }
      )
      if (rows.length > 0) {
        gsap.fromTo(
          rows,
          { autoAlpha: 0, x: -7 },
          {
            autoAlpha: 1,
            x: 0,
            duration: 0.22,
            stagger: 0.02,
            delay: 0.03,
            ease: 'power2.out',
            onComplete: () => gsap.set(rows, { clearProps: 'opacity,visibility,transform' })
          }
        )
      }
    },
    { scope }
  )
}

export function useSearchFocusMotion(scope: RefObject<HTMLElement | null>, focused: boolean): void {
  useGSAP(
    () => {
      const root = scope.current
      if (!root) return
      const rule = root.querySelector<HTMLElement>('[data-search-rule]')
      const icon = root.querySelector<HTMLElement>('[data-search-icon]')
      if (prefersReducedMotion()) {
        if (rule) {
          gsap.to(rule, {
            scaleX: 1,
            autoAlpha: focused ? 1 : 0,
            duration: 0.12,
            overwrite: 'auto'
          })
        }
        if (icon) gsap.set(icon, { x: 0, y: 0 })
        return
      }
      if (rule) {
        gsap.to(rule, {
          scaleX: focused ? 1 : 0,
          autoAlpha: focused ? 1 : 0,
          duration: 0.28,
          ease: 'power2.out',
          transformOrigin: 'left center',
          overwrite: 'auto'
        })
      }
      if (icon) {
        gsap.to(icon, {
          x: focused ? 1 : 0,
          y: focused ? -1 : 0,
          duration: 0.24,
          ease: 'power2.out',
          overwrite: 'auto'
        })
      }
    },
    { dependencies: [focused], scope }
  )
}

export function useGroupSwitchMotion(scope: RefObject<HTMLElement | null>, active: string): void {
  const previous = useRef<{ x: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const root = scope.current
    if (!root) return
    const thumb = root.querySelector<HTMLElement>('[data-group-thumb]')
    const activeTab = root.querySelector<HTMLElement>(`[data-group-tab="${active}"]`)
    if (!thumb || !activeTab) return

    const next = { x: activeTab.offsetLeft, width: activeTab.offsetWidth }
    if (previous.current && !prefersReducedMotion()) {
      const xValue = Number.parseFloat(String(gsap.getProperty(thumb, 'x')))
      const widthValue = Number.parseFloat(String(gsap.getProperty(thumb, 'width')))
      const currentX = Number.isFinite(xValue) ? xValue : previous.current.x
      const currentWidth = Number.isFinite(widthValue) ? widthValue : previous.current.width
      gsap.fromTo(
        thumb,
        { x: currentX, width: currentWidth, autoAlpha: 1 },
        {
          ...next,
          autoAlpha: 1,
          duration: 0.3,
          ease: 'power3.out',
          overwrite: true
        }
      )
    } else {
      gsap.set(thumb, { ...next, autoAlpha: 1 })
    }
    previous.current = next

    if (typeof ResizeObserver === 'undefined') return
    let firstObservation = true
    const observer = new ResizeObserver(() => {
      if (firstObservation) {
        firstObservation = false
        return
      }
      const currentThumb = root.querySelector<HTMLElement>('[data-group-thumb]')
      const currentTab = root.querySelector<HTMLElement>(`[data-group-tab="${active}"]`)
      if (!currentThumb || !currentTab) return
      const resized = { x: currentTab.offsetLeft, width: currentTab.offsetWidth }
      previous.current = resized
      gsap.set(currentThumb, { ...resized, autoAlpha: 1 })
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [active, scope])
}

export function useReadStateMotion(scope: RefObject<HTMLElement | null>, state: string): void {
  useGSAP(
    () => {
      const node = scope.current?.querySelector<HTMLElement>(`[data-read-state="${state}"]`)
      if (!node) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          node,
          { autoAlpha: 0.6 },
          {
            autoAlpha: 1,
            duration: 0.12,
            onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        node,
        { autoAlpha: 0.45, y: -3 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.28,
          ease: 'power2.out',
          onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility,transform' })
        }
      )
    },
    { dependencies: [state], scope }
  )
}

export function useContextMenuMotion(
  scope: RefObject<HTMLElement | null>,
  signature: string
): void {
  useGSAP(
    () => {
      const node = scope.current
      if (!node) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          node,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.1,
            onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        node,
        { autoAlpha: 0, scale: 0.965, y: -5 },
        {
          autoAlpha: 1,
          scale: 1,
          y: 0,
          duration: 0.18,
          ease: 'power2.out',
          transformOrigin: 'top left',
          onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility,transform' })
        }
      )
    },
    { dependencies: [signature], scope, revertOnUpdate: true }
  )
}

export function useClipboardBannerMotion(
  scope: RefObject<HTMLElement | null>,
  signature: string
): void {
  useGSAP(
    () => {
      const node = scope.current
      if (!node) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          node,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        node,
        { autoAlpha: 0, y: -6, scaleY: 0.94 },
        {
          autoAlpha: 1,
          y: 0,
          scaleY: 1,
          duration: 0.22,
          ease: 'power2.out',
          transformOrigin: 'top center',
          onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility,transform' })
        }
      )
    },
    { dependencies: [signature], scope }
  )
}

export function useDropOverlayMotion(scope: RefObject<HTMLElement | null>, active: boolean): void {
  useGSAP(
    () => {
      const node = scope.current
      if (!node) return
      gsap.to(node, {
        autoAlpha: active ? 1 : 0,
        duration: prefersReducedMotion() ? 0.08 : 0.16,
        ease: 'power1.out',
        overwrite: 'auto'
      })
    },
    { dependencies: [active], scope }
  )
}

export function useStateArtMotion(scope: RefObject<HTMLElement | null>): void {
  useGSAP(
    () => {
      const node = scope.current
      if (!node) return
      const arts = node.querySelectorAll<HTMLElement>('[data-state-art]')
      if (prefersReducedMotion()) {
        gsap.fromTo(
          node,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        node,
        { autoAlpha: 0, y: 10 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.3,
          ease: 'power2.out',
          onComplete: () => gsap.set(node, { clearProps: 'opacity,visibility,transform' })
        }
      )
      if (arts.length > 0) {
        gsap.fromTo(
          arts,
          { autoAlpha: 0, y: 8, scale: 0.96 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 0.32,
            stagger: 0.05,
            delay: 0.04,
            ease: 'power2.out',
            onComplete: () => gsap.set(arts, { clearProps: 'opacity,visibility,transform' })
          }
        )
      }
    },
    { scope }
  )
}
