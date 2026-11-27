import gsap from 'gsap'
import { useEffect } from 'react'

import { prefersReducedMotion } from '@presentation/effects/motion'

import {
  guideHaloColorOf,
  guidePulsePeak,
  guidePulseStart,
  guideSteadyHalo
} from './useGuideMarkers'

const RETURN_TARGET = '[data-guide-return="preview"]'
const RETURN_MARK = 'data-guide-return-guide'

/**
 * 需要从试玩预览返回工作台时，只对页面里真实的「返回工作台」按钮做引导：
 * 进入阶段时脉冲一次，随后保留静态光环；点击按钮或离开阶段立即停止并还原内联样式。
 * 减少动态时只显示同一静态光环；按钮自身仍是可 Tab 聚焦的原生按钮。
 */
export function useGuideReturnPulse(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined

    let detach = (): void => undefined
    const attach = (): boolean => {
      const button = document.querySelector<HTMLElement>(RETURN_TARGET)
      if (button === null) return false

      const previousBoxShadow = button.style.boxShadow
      const color = guideHaloColorOf()
      const steady = guideSteadyHalo(color)
      let timeline: gsap.core.Timeline | null = null
      let cleaned = false

      button.style.boxShadow = steady
      button.setAttribute(RETURN_MARK, 'true')
      if (!prefersReducedMotion()) {
        timeline = gsap.timeline()
        timeline
          .fromTo(
            button,
            { boxShadow: guidePulseStart(color) },
            { boxShadow: guidePulsePeak(color), duration: 0.32, ease: 'power2.out' }
          )
          .to(button, { boxShadow: steady, duration: 0.6, ease: 'power2.inOut' })
          .eventCallback('onComplete', () => {
            timeline = null
          })
      }

      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        timeline?.kill()
        timeline = null
        button.style.boxShadow = previousBoxShadow
        button.removeAttribute(RETURN_MARK)
      }
      button.addEventListener('click', cleanup)
      detach = () => {
        button.removeEventListener('click', cleanup)
        cleanup()
      }
      return true
    }

    if (attach()) {
      return () => {
        detach()
      }
    }

    // 预览页和 Host 在同一次提交里挂载；若按钮晚一拍出现，等它出现再挂引导。
    const observer = new MutationObserver(() => {
      if (!attach()) return
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      detach()
    }
  }, [active])
}
