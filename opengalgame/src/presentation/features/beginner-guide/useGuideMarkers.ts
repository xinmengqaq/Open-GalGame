import gsap from 'gsap'
import { useEffect, useRef } from 'react'

import { prefersReducedMotion, subscribeReducedMotion } from '../../effects/motion'
import { guideArrangeViewOf, type GuideSessionState } from './advanceGuide'
import { locateGuideAction } from './locateGuideAction'

type MarkerRecord = {
  previousBoxShadow: string
  timeline: gsap.core.Timeline | null
}

export type GuideHaloColor = { red: number; green: number; blue: number }

/** 读页面主题里的 --purple；读不到时退回设计稿紫色。 */
export function guideHaloColorOf(): GuideHaloColor {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--purple').trim()
  const [red, green, blue] = gsap.utils.splitColor(accent || '#8d67ab')
  return { red, green, blue }
}

function rgba(color: GuideHaloColor, alpha: number): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha})`
}

/** 常驻光环：1px 内环 + 柔和外扩散，不占布局，也不靠硬描边。 */
export function guideSteadyHalo(color: GuideHaloColor): string {
  return [
    `0 0 0 1px ${rgba(color, 0.5)}`,
    `0 0 0 4px ${rgba(color, 0.14)}`,
    `0 0 22px 6px ${rgba(color, 0.22)}`
  ].join(', ')
}

/** 进入目标时的一次短脉动：先扩开再落回常驻光环。 */
export function guidePulseStart(color: GuideHaloColor): string {
  return [
    `0 0 0 0 ${rgba(color, 0)}`,
    `0 0 0 0 ${rgba(color, 0)}`,
    `0 0 0 0 ${rgba(color, 0)}`
  ].join(', ')
}

export function guidePulsePeak(color: GuideHaloColor): string {
  return [
    `0 0 0 1px ${rgba(color, 0.82)}`,
    `0 0 0 8px ${rgba(color, 0.22)}`,
    `0 0 30px 10px ${rgba(color, 0.42)}`
  ].join(', ')
}

/** 教程自己的面板、入口、目录不参与页面目标高亮。 */
export function isPageGuideTarget(element: HTMLElement): boolean {
  return element.closest('[data-guide-portal]') === null
}

/** 只保留页面里的实际控件；同一目标只 pulse 一次，跳步时再换新目标。 */
export function pageGuideTargets(elements: readonly HTMLElement[]): HTMLElement[] {
  return elements.filter(isPageGuideTarget)
}

function restoreInlineStyle(element: HTMLElement, record: MarkerRecord): void {
  element.style.boxShadow = record.previousBoxShadow
}

function removeMarker(element: HTMLElement, records: Map<HTMLElement, MarkerRecord>): void {
  const record = records.get(element)
  if (!record) return
  record.timeline?.kill()
  restoreInlineStyle(element, record)
  element.removeAttribute('data-guide-current')
  records.delete(element)
}

function addMarker(
  element: HTMLElement,
  records: Map<HTMLElement, MarkerRecord>,
  reducedMotion: boolean
): void {
  if (records.has(element)) return
  const record: MarkerRecord = {
    previousBoxShadow: element.style.boxShadow,
    timeline: null
  }
  records.set(element, record)
  element.setAttribute('data-guide-current', '')

  const color = guideHaloColorOf()
  const steady = guideSteadyHalo(color)
  // 先给常驻光环，保证减少动态或动画被中断时仍有明确但不刺眼的目标提示。
  element.style.boxShadow = steady
  if (reducedMotion) return

  const timeline = gsap.timeline()
  record.timeline = timeline
  timeline
    .fromTo(
      element,
      { boxShadow: guidePulseStart(color) },
      { boxShadow: guidePulsePeak(color), duration: 0.3, ease: 'power2.out' }
    )
    .to(element, { boxShadow: steady, duration: 0.55, ease: 'power2.inOut' })
    .eventCallback('onComplete', () => {
      if (records.get(element) !== record) return
      record.timeline = null
    })
}

/** 动画被中途停掉时，减少动态保留常驻光环，其余情况交还给元素原样式。 */
function stopPulses(records: Map<HTMLElement, MarkerRecord>, keepHalo: boolean): void {
  const color = guideHaloColorOf()
  for (const [element, record] of records) {
    record.timeline?.kill()
    record.timeline = null
    if (keepHalo) element.style.boxShadow = guideSteadyHalo(color)
  }
}

export function useGuideMarkers(guide: GuideSessionState | null, suspended = false): void {
  const recordsRef = useRef<Map<HTMLElement, MarkerRecord>>(new Map())

  useEffect(() => {
    const records = recordsRef.current

    const sync = (targets: readonly HTMLElement[]): void => {
      const next = new Set(pageGuideTargets(targets))
      for (const element of [...records.keys()]) {
        if (!next.has(element)) removeMarker(element, records)
      }
      for (const element of next) addMarker(element, records, prefersReducedMotion())
    }

    const active = guide !== null && guide.status === 'following' && !suspended
    if (!active) {
      sync([])
      return
    }

    const refresh = (): void => {
      sync(locateGuideAction(guide, guideArrangeViewOf(guide)))
    }
    const unsubscribe = subscribeReducedMotion((reduced) => {
      if (reduced) {
        stopPulses(records, true)
        return
      }
      for (const element of [...records.keys()]) removeMarker(element, records)
      refresh()
    })
    refresh()
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (change) =>
            change.attributeName !== 'data-guide-current' && change.attributeName !== 'style'
        )
      ) {
        refresh()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    document.addEventListener('input', refresh)
    window.addEventListener('resize', refresh)
    return () => {
      unsubscribe()
      observer.disconnect()
      document.removeEventListener('input', refresh)
      window.removeEventListener('resize', refresh)
    }
  }, [guide, suspended])

  // 离开教程或卸载时清掉所有页面控件上的描边和内联动画值；
  // 同一步内的重渲染只做目标差集，不重播已经稳定的目标。
  useEffect(() => {
    const records = recordsRef.current
    return () => {
      for (const element of [...records.keys()]) removeMarker(element, records)
    }
  }, [])
}
