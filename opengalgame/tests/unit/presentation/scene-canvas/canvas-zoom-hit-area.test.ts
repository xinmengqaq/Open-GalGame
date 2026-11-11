import { describe, expect, it, vi } from 'vitest'

import {
  CANVAS_MIN_HIT_PX,
  CANVAS_PORT_HIT_BASE_PX,
  CANVAS_PORT_MIN_SCREEN_PX,
  applyCanvasZoomInverse,
  canvasPortHitPx,
  canvasZoomInverse
} from '@presentation/features/scene-canvas/canvasZoomHitArea'

describe('画布低缩放命中补偿', () => {
  it('命中盒的最小屏幕边长与 CSS 侧 24px 约定一致', () => {
    expect(CANVAS_MIN_HIT_PX).toBe(24)
  })

  it('缩放倒数按 1/zoom 计算，供 CSS 变量换算 flow px', () => {
    expect(canvasZoomInverse(1)).toBe(1)
    expect(canvasZoomInverse(0.5)).toBe(2)
    expect(canvasZoomInverse(0.32)).toBeCloseTo(3.125, 6)
    expect(canvasZoomInverse(1.8)).toBeCloseTo(1 / 1.8, 6)
  })

  it('非法缩放回退为 1，避免命中盒被无限放大', () => {
    expect(canvasZoomInverse(0)).toBe(1)
    expect(canvasZoomInverse(-0.5)).toBe(1)
    expect(canvasZoomInverse(Number.NaN)).toBe(1)
    expect(canvasZoomInverse(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('端口命中盒按 28px 屏幕补足，zoom=1 仍保持 44px', () => {
    expect(CANVAS_PORT_MIN_SCREEN_PX).toBe(28)
    expect(CANVAS_PORT_HIT_BASE_PX).toBe(44)

    expect(canvasPortHitPx(1)).toBe(44)
    expect(canvasPortHitPx(1.8)).toBe(44)
    expect(canvasPortHitPx(0.32)).toBeCloseTo(28 * canvasZoomInverse(0.32), 6)
    expect(canvasPortHitPx(0.32) * 0.32).toBeCloseTo(28, 6)
    expect(canvasPortHitPx(0.6) * 0.6).toBeCloseTo(28, 6)
  })

  it('把倒数字符串写进 --canvas-zoom-inverse，元素缺失时静默跳过', () => {
    const setProperty = vi.fn()
    const element = { style: { setProperty } }

    applyCanvasZoomInverse(element, 0.5)

    expect(setProperty).toHaveBeenCalledWith('--canvas-zoom-inverse', '2')

    setProperty.mockClear()
    applyCanvasZoomInverse(null, 0.5)
    expect(setProperty).not.toHaveBeenCalled()
  })
})
