import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion, subscribeReducedMotion } from '../../effects/motion'

interface GuideOverlayMotionOptions {
  textRef: RefObject<HTMLElement | null>
  textSignature: string
}

/**
 * M1：当前动作确实变化时，只让标题和正文这一组做 160ms 的短淡入。
 * 外框、进度、按钮、焦点和拖动位置都不参与动画；首次打开直接显示。
 * 同一文案重渲染不播放，快速换拍/换步会取消前一段并直接显示最新内容。
 * 系统减少动态效果时立即显示终态，动画中途切换偏好也会被 matchMedia 清理。
 */
export function useGuideOverlayMotion({ textRef, textSignature }: GuideOverlayMotionOptions): void {
  const previousSignature = useRef<string | null>(null)
  useGSAP(
    () => {
      const text = textRef.current
      const previous = previousSignature.current
      previousSignature.current = textSignature
      if (!text) return
      if (previous === null || previous === textSignature) return

      gsap.killTweensOf(text)
      gsap.set(text, { clearProps: 'opacity,transform' })
      const showFinal = (): void => {
        gsap.killTweensOf(text)
        gsap.set(text, { clearProps: 'opacity,transform' })
      }
      const unsubscribe = subscribeReducedMotion((reduced) => {
        if (reduced) showFinal()
      })
      if (prefersReducedMotion()) {
        return unsubscribe
      }
      const tween = gsap.fromTo(
        text,
        { opacity: 0.65, y: 3 },
        {
          opacity: 1,
          y: 0,
          duration: 0.16,
          ease: 'power2.out',
          clearProps: 'opacity,transform',
          overwrite: 'auto'
        }
      )
      return () => {
        unsubscribe()
        tween.kill()
        gsap.set(text, { clearProps: 'opacity,transform' })
      }
    },
    { dependencies: [textSignature], revertOnUpdate: true }
  )
}

interface GuideConnectionMotionOptions {
  playToken: number
  lineRef: RefObject<SVGPathElement | null>
  labelRef: RefObject<SVGGElement | null>
  leftPortRef: RefObject<SVGCircleElement | null>
  rightPortRef: RefObject<SVGCircleElement | null>
}

/**
 * M2：用户点「播放连线」后，按 0–120ms 左端口轻点、120–540ms 线从
 * 剧本一端长到开场图一端、540–660ms 右端口轻点、600–780ms 关系名出现。
 * 归一化描边只动 dashoffset；播完停在成图，重播只重置这枚 SVG。
 * 关闭、跳步、卸载或切入试玩时随组件卸载立即 kill，不回放迟到帧。
 * 减少动态效果时直接给出完整连线；播放中切换偏好会停表并落成终态，
 * 切回普通动效不会自动重播。
 */
export function useGuideConnectionMotion({
  playToken,
  lineRef,
  labelRef,
  leftPortRef,
  rightPortRef
}: GuideConnectionMotionOptions): void {
  useGSAP(
    () => {
      const line = lineRef.current
      const label = labelRef.current
      const leftPort = leftPortRef.current
      const rightPort = rightPortRef.current
      if (!line || !label || !leftPort || !rightPort) return

      const targets = [line, label, leftPort, rightPort]
      let timeline: gsap.core.Timeline | null = null

      const stop = (): void => {
        timeline?.kill()
        timeline = null
        gsap.killTweensOf(targets)
      }

      const showInitial = (): void => {
        stop()
        gsap.set([leftPort, rightPort], { transformOrigin: '50% 50%', scale: 1 })
        gsap.set(line, { strokeDasharray: 1, strokeDashoffset: 1 })
        gsap.set(label, { transformOrigin: '50% 50%', autoAlpha: 0, y: 3 })
      }

      const showComplete = (): void => {
        stop()
        gsap.set([leftPort, rightPort], { transformOrigin: '50% 50%', scale: 1 })
        gsap.set(line, { strokeDasharray: 1, strokeDashoffset: 0 })
        gsap.set(label, { transformOrigin: '50% 50%', autoAlpha: 1, y: 0 })
      }

      if (prefersReducedMotion()) showComplete()
      else showInitial()

      // 只跟随有效动效状态：减少时直接落成终态，切回完整动效不重放。
      const unsubscribe = subscribeReducedMotion((reduced) => {
        if (reduced) showComplete()
      })

      if (playToken > 0 && !prefersReducedMotion()) {
        timeline = gsap.timeline()
        timeline
          .fromTo(
            leftPort,
            { scale: 1 },
            {
              scale: 1.12,
              duration: 0.06,
              ease: 'power1.out',
              yoyo: true,
              repeat: 1,
              transformOrigin: '50% 50%'
            },
            0
          )
          .to(
            line,
            {
              strokeDashoffset: 0,
              duration: 0.42,
              ease: 'power1.inOut',
              autoRound: false
            },
            0.12
          )
          .fromTo(
            rightPort,
            { scale: 1 },
            {
              scale: 1.12,
              duration: 0.06,
              ease: 'power1.out',
              yoyo: true,
              repeat: 1,
              transformOrigin: '50% 50%'
            },
            0.54
          )
          .fromTo(
            label,
            { autoAlpha: 0, y: 3 },
            { autoAlpha: 1, y: 0, duration: 0.18, ease: 'power2.out' },
            0.6
          )
      }

      return () => {
        unsubscribe()
        timeline?.kill()
        gsap.set(targets, {
          clearProps: 'transform,opacity,visibility,stroke-dasharray,stroke-dashoffset'
        })
      }
    },
    { dependencies: [playToken], revertOnUpdate: true }
  )
}
