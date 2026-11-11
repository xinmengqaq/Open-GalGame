import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

interface SceneCanvasMotionOptions {
  root: RefObject<HTMLElement | null>
  relationKey: string
  emptyVisible: boolean
}

/**
 * 画布工具的入场与关系标签出现。
 * 减少动态效果时只做短淡入；结束后清掉内联 transform/opacity。
 */
export function useSceneCanvasMotion({
  root,
  relationKey,
  emptyVisible
}: SceneCanvasMotionOptions): void {
  const knownRelations = useRef<Set<string>>(new Set())
  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const toolbar = node.querySelectorAll('[data-motion="toolbar"]')
      const groups = node.querySelectorAll('[data-motion="toolbar-group"]')
      if (toolbar.length === 0) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          toolbar,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.14,
            onComplete: () => gsap.set(toolbar, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      const timeline = gsap.timeline()
      timeline
        .from(toolbar, { y: 18, autoAlpha: 0, duration: 0.5, ease: 'power3.out' })
        .from(
          groups,
          { y: 8, autoAlpha: 0, duration: 0.3, stagger: 0.05, ease: 'power2.out' },
          '<0.12'
        )
        .eventCallback('onComplete', () => {
          gsap.set([...toolbar, ...groups], { clearProps: 'transform,opacity,visibility' })
        })
    },
    { scope: root }
  )

  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const current = new Map<string, HTMLElement>()
      for (const label of node.querySelectorAll<HTMLElement>('[data-motion="relation-label"]')) {
        const relationId = label.dataset.relationId
        if (relationId) current.set(relationId, label)
      }
      const entering = [...current.entries()]
        .filter(([relationId]) => !knownRelations.current.has(relationId))
        .map(([, label]) => label)
      knownRelations.current = new Set(current.keys())
      if (entering.length === 0) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          entering,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.12,
            onComplete: () => gsap.set(entering, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        entering,
        { autoAlpha: 0, y: 6, scale: 0.95 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.3,
          stagger: 0.04,
          ease: 'back.out(1.7)',
          onComplete: () => gsap.set(entering, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope: root, dependencies: [relationKey] }
  )

  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const empty = node.querySelectorAll('[data-motion="canvas-empty"]')
      if (empty.length === 0) return
      if (prefersReducedMotion()) {
        gsap.fromTo(
          empty,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.14,
            onComplete: () => gsap.set(empty, { clearProps: 'opacity,visibility' })
          }
        )
        return
      }
      gsap.fromTo(
        empty,
        { autoAlpha: 0, y: 12, scale: 0.985 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.46,
          ease: 'power3.out',
          onComplete: () => gsap.set(empty, { clearProps: 'transform,opacity,visibility' })
        }
      )
    },
    { scope: root, dependencies: [emptyVisible] }
  )
}
