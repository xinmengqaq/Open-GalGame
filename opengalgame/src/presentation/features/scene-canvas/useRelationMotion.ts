import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

interface RelationLabelMotionOptions {
  root: RefObject<HTMLDivElement | null>
  signature: string
  active: boolean
  rejected: boolean
  loadable: boolean
}

interface RelationEdgeMotionOptions {
  root: RefObject<SVGGElement | null>
  pending: boolean
  active: boolean
  rejected: boolean
}

interface RelationDialogMotionOptions {
  root: RefObject<HTMLFormElement | null>
  relationId: string
  recordId: string
  tone: 'named' | 'unnamed'
}

function fadeIn(targets: Element[], duration: number, onDone?: () => void): void {
  if (targets.length === 0) return
  gsap.fromTo(
    targets,
    { autoAlpha: 0 },
    {
      autoAlpha: 1,
      duration,
      ease: 'power1.out',
      onComplete: () => {
        gsap.set(targets, { clearProps: 'opacity,visibility' })
        onDone?.()
      }
    }
  )
}

function clearMotion(targets: Array<Element | null>, properties: string): void {
  const nodes = targets.filter((target): target is Element => target !== null)
  if (nodes.length > 0) gsap.set(nodes, { clearProps: properties })
}

/** 关系标签：状态签名变化时短促出现；选中短强调；拒绝时回弹。 */
export function useRelationLabelMotion({
  root,
  signature,
  active,
  rejected,
  loadable
}: RelationLabelMotionOptions): void {
  const previousSignature = useRef<string | null>(null)

  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const label = node.querySelector<HTMLElement>('[data-motion="relation-label"]')
      const port = node.querySelector<HTMLElement>('[data-motion="relation-port"]')
      if (!label) return
      const changed = previousSignature.current !== null && previousSignature.current !== signature
      previousSignature.current = signature

      if (prefersReducedMotion()) {
        if (changed) fadeIn([label], 0.12)
        return
      }

      if (changed) {
        const timeline = gsap.timeline()
        timeline.fromTo(
          label,
          { autoAlpha: 0, y: 6, scale: 0.94 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: 'back.out(1.6)' }
        )
        if (port) {
          timeline.fromTo(
            port,
            { scale: 0.4, autoAlpha: 0.5 },
            { scale: 1, autoAlpha: 1, duration: 0.24, ease: 'back.out(2)' },
            '<0.04'
          )
        }
        timeline.eventCallback('onComplete', () => {
          clearMotion([label, port], 'transform,opacity,visibility')
        })
      }

      if (rejected) {
        gsap
          .timeline()
          .to(label, { x: -5, duration: 0.06, ease: 'power1.out' })
          .to(label, { x: 5, duration: 0.07, ease: 'power1.inOut' })
          .to(label, { x: -3, duration: 0.06, ease: 'power1.inOut' })
          .to(label, { x: 0, duration: 0.08, ease: 'power1.out' })
          .eventCallback('onComplete', () => clearMotion([label], 'transform'))
        if (port) {
          gsap.fromTo(
            port,
            { scale: 1.2 },
            {
              scale: 1,
              duration: 0.28,
              ease: 'back.out(2.4)',
              onComplete: () => clearMotion([port], 'transform')
            }
          )
        }
      } else if (active && !changed) {
        gsap.fromTo(
          label,
          { scale: 1 },
          {
            scale: 1.04,
            duration: 0.14,
            yoyo: true,
            repeat: 1,
            ease: 'power2.out',
            onComplete: () => clearMotion([label], 'transform')
          }
        )
        if (port) {
          gsap.fromTo(
            port,
            { scale: 0.86 },
            {
              scale: 1,
              duration: 0.24,
              ease: 'back.out(2)',
              onComplete: () => clearMotion([port], 'transform')
            }
          )
        }
      } else if (loadable && !changed) {
        if (port) {
          gsap.fromTo(
            port,
            { scale: 0.7 },
            {
              scale: 1,
              duration: 0.3,
              ease: 'back.out(2.4)',
              onComplete: () => clearMotion([port], 'transform')
            }
          )
        }
      }
    },
    { scope: root, dependencies: [signature, active, rejected, loadable] }
  )
}

/** 关系线：首次进入绘制感一次；选中短亮；拒绝时红色轮廓快速回弹。 */
export function useRelationEdgeMotion({
  root,
  pending,
  active,
  rejected
}: RelationEdgeMotionOptions): void {
  const mounted = useRef(false)

  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const line = node.querySelector<SVGPathElement>('[data-motion="relation-edge-line"]')
      const glow = node.querySelector<SVGPathElement>('[data-motion="relation-edge-glow"]')
      if (!line) return
      const entering = !mounted.current
      mounted.current = true

      if (prefersReducedMotion()) {
        if (entering) fadeIn([line], 0.12)
        return
      }

      if (entering) {
        gsap.fromTo(
          line,
          { autoAlpha: 0 },
          {
            autoAlpha: 1,
            duration: 0.3,
            ease: 'power2.out',
            onComplete: () => clearMotion([line], 'opacity,visibility')
          }
        )
        if (pending) {
          gsap.fromTo(
            line,
            { strokeDashoffset: 28 },
            {
              strokeDashoffset: 0,
              duration: 0.56,
              ease: 'power2.out',
              onComplete: () => clearMotion([line], 'stroke-dashoffset')
            }
          )
        }
        if (glow) {
          gsap.fromTo(
            glow,
            { opacity: 0 },
            {
              opacity: 0.18,
              duration: 0.4,
              yoyo: true,
              repeat: 1,
              ease: 'power2.out',
              onComplete: () => clearMotion([glow], 'opacity')
            }
          )
        }
        return
      }

      if (rejected && glow) {
        gsap.fromTo(
          glow,
          { opacity: 0.08 },
          {
            opacity: 0.55,
            duration: 0.12,
            yoyo: true,
            repeat: 3,
            ease: 'power1.inOut',
            onComplete: () => clearMotion([glow], 'opacity')
          }
        )
        return
      }

      if (active && glow) {
        gsap.fromTo(
          glow,
          { opacity: 0.12 },
          {
            opacity: 0.32,
            duration: 0.2,
            yoyo: true,
            repeat: 1,
            ease: 'power2.out',
            onComplete: () => clearMotion([glow], 'opacity')
          }
        )
      }
    },
    { scope: root, dependencies: [pending, active, rejected] }
  )
}

/** 绘制中：停掉常驻奔跑虚线，改为一次更强的线宽与端点强调。 */
export function useConnectionPreviewMotion(
  root: RefObject<HTMLDivElement | null>,
  connecting: boolean
): void {
  useGSAP(
    () => {
      if (!connecting) return
      const node = root.current
      if (!node) return

      const draw = (): void => {
        const lines = Array.from(
          node.querySelectorAll<SVGPathElement>('.react-flow__connection-path')
        )
        const glows: SVGPathElement[] = []
        const dots: SVGCircleElement[] = []
        const preview = node.querySelector<SVGSVGElement>(':scope > svg')
        if (preview) {
          const paths = Array.from(preview.querySelectorAll<SVGPathElement>('path'))
          const line = paths.at(-1)
          if (line) lines.push(line)
          for (const glow of paths.slice(0, -1)) glows.push(glow)
          dots.push(...preview.querySelectorAll<SVGCircleElement>('circle'))
        }
        if (lines.length === 0) return

        for (const path of [...lines, ...glows]) {
          path.style.animation = 'none'
          path.style.stroke = '#3f3a4a'
        }
        for (const line of lines) line.style.strokeWidth = '2.8'
        for (const dot of dots) dot.style.stroke = '#3f3a4a'

        if (prefersReducedMotion()) {
          fadeIn([...lines, ...glows], 0.12)
          return
        }

        gsap.fromTo(
          lines,
          { autoAlpha: 0.55, strokeWidth: 1.4 },
          {
            autoAlpha: 1,
            strokeWidth: 2.8,
            duration: 0.2,
            ease: 'power2.out',
            onComplete: () => clearMotion(lines, 'opacity,visibility')
          }
        )
        if (glows.length > 0) {
          gsap.fromTo(
            glows,
            { autoAlpha: 0.35 },
            {
              autoAlpha: 1,
              duration: 0.22,
              ease: 'power2.out',
              onComplete: () => clearMotion(glows, 'opacity,visibility')
            }
          )
        }
        if (dots.length > 0) {
          gsap.fromTo(
            dots,
            { scale: 0.5, transformOrigin: '50% 50%' },
            {
              scale: 1,
              duration: 0.28,
              ease: 'back.out(2)',
              onComplete: () => clearMotion(dots, 'transform')
            }
          )
        }
      }

      gsap.delayedCall(0.03, draw)
    },
    { scope: root, dependencies: [connecting] }
  )
}

/** 关系弹窗：打开时强调条展开、端点卡片错峰出现；记录变化时短促回落。 */
export function useRelationDialogMotion({
  root,
  relationId,
  recordId,
  tone
}: RelationDialogMotionOptions): void {
  const previous = useRef<{ relationId: string; recordId: string } | null>(null)

  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const accent = node.querySelector<HTMLElement>('[data-motion="relation-dialog-accent"]')
      const chips = Array.from(
        node.querySelectorAll<HTMLElement>('[data-motion="relation-dialog-chip"]')
      )
      const record = node.querySelector<HTMLElement>('[data-motion="relation-dialog-record"]')
      const recordChanged =
        previous.current?.relationId === relationId && previous.current.recordId !== recordId
      previous.current = { relationId, recordId }

      if (prefersReducedMotion()) {
        fadeIn(
          [...chips, record].filter((item): item is HTMLElement => item !== null),
          0.12
        )
        return
      }

      if (recordChanged && record) {
        gsap.fromTo(
          record,
          { autoAlpha: 0.55, scale: 0.985 },
          {
            autoAlpha: 1,
            scale: 1,
            duration: 0.3,
            ease: 'back.out(1.8)',
            onComplete: () => clearMotion([record], 'transform,opacity,visibility')
          }
        )
        return
      }

      const timeline = gsap.timeline()
      if (accent) {
        timeline.fromTo(
          accent,
          { scaleY: 0 },
          { scaleY: 1, duration: 0.4, ease: 'power3.out', transformOrigin: 'top center' }
        )
      }
      if (chips.length > 0) {
        timeline.fromTo(
          chips,
          { autoAlpha: 0, y: 7 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.3,
            stagger: 0.05,
            ease: 'power2.out'
          },
          '<0.06'
        )
      }
      if (record) {
        timeline.fromTo(
          record,
          { autoAlpha: 0.4 },
          { autoAlpha: 1, duration: 0.26, ease: 'power2.out' },
          '<0.12'
        )
      }
      timeline.eventCallback('onComplete', () => {
        clearMotion([accent, ...chips, record], 'transform,opacity,visibility')
      })
    },
    { scope: root, dependencies: [relationId, recordId, tone] }
  )
}
