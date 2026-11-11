/** 画布命中盒在屏幕上的最小边长；低缩放时按它换算成 flow px 补足命中。 */
export const CANVAS_MIN_HIT_PX = 24

/** 端口在正常缩放下的基准命中边长，与 CSS 里 44px 的约定一致。 */
export const CANVAS_PORT_HIT_BASE_PX = 44

/** 端口在低缩放下的最小屏幕命中边长，对应 --port-hit 的 28px 屏幕热区。 */
export const CANVAS_PORT_MIN_SCREEN_PX = 28

/** 只要求写 CSS 变量的能力，便于命中补偿的纯函数单测。 */
type CanvasZoomVariableTarget = {
  style: { setProperty(name: string, value: string): void }
}

/** 视口缩放倒数：命中盒用 max(视觉尺寸, 最小屏幕边长 * 倒数) 保证低缩放下的屏幕命中。 */
export function canvasZoomInverse(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1
}

/** 端口命中盒的 flow px 边长：低缩放按 28px 屏幕补足，正常缩放不低于 44px。 */
export function canvasPortHitPx(zoom: number): number {
  return Math.max(CANVAS_PORT_HIT_BASE_PX, CANVAS_PORT_MIN_SCREEN_PX * canvasZoomInverse(zoom))
}

/** 把缩放倒数写进画布祖先的 --canvas-zoom-inverse；元素未挂载时静默跳过。 */
export function applyCanvasZoomInverse(
  element: CanvasZoomVariableTarget | null,
  zoom: number
): void {
  element?.style.setProperty('--canvas-zoom-inverse', String(canvasZoomInverse(zoom)))
}
