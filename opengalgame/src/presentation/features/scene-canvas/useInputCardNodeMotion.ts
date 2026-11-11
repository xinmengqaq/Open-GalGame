import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef, type RefObject } from 'react'

import { prefersReducedMotion } from '../../effects/motion'

interface InputCardNodeMotionOptions {
  root: RefObject<HTMLDivElement | null>
  connecting: boolean
  rejected: boolean
}

/**
 * 拒绝反馈：只在一次连接结束、且这张卡是拒绝起点时播放一次轮廓回弹。
 * 动画只作用于外围覆盖层，不覆盖 React Flow 的节点坐标 transform。
 */
export function useInputCardNodeMotion({
  root,
  connecting,
  rejected
}: InputCardNodeMotionOptions): void {
  const wasConnecting = useRef(false)
  const armed = useRef(true)

  useGSAP(
    () => {
      const node = root.current
      if (!node) return
      const aura = node.querySelector<HTMLElement>('[data-motion="card-reject-aura"]')

      if (connecting) {
        wasConnecting.current = true
        armed.current = true
        return
      }

      if (!rejected) {
        wasConnecting.current = false
        if (aura) gsap.set(aura, { clearProps: 'opacity,visibility,transform' })
        return
      }

      if (!wasConnecting.current || !armed.current || !aura) return
      armed.current = false

      if (prefersReducedMotion()) {
        gsap
          .timeline()
          .fromTo(aura, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12, ease: 'power1.out' })
          .to(aura, { autoAlpha: 0, duration: 0.18, ease: 'power1.in' })
          .eventCallback('onComplete', () =>
            gsap.set(aura, { clearProps: 'opacity,visibility,transform' })
          )
        return
      }

      gsap
        .timeline({
          onComplete: () => gsap.set(aura, { clearProps: 'opacity,visibility,transform' })
        })
        .fromTo(
          aura,
          { autoAlpha: 0, scale: 0.985 },
          { autoAlpha: 1, scale: 1.012, duration: 0.15, ease: 'power2.out' }
        )
        .to(aura, { autoAlpha: 0, scale: 1.02, duration: 0.28, ease: 'power1.in' }, 0.2)
    },
    { scope: root, dependencies: [connecting, rejected] }
  )
}
