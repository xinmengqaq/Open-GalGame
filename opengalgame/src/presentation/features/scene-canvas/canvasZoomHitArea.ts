export const CANVAS_MIN_HIT_PX = 24

export const CANVAS_PORT_HIT_BASE_PX = 44

export const CANVAS_PORT_MIN_SCREEN_PX = 28

type CanvasZoomVariableTarget = {
  style: { setProperty(name: string, value: string): void }
}

export function canvasZoomInverse(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1
}

export function canvasPortHitPx(zoom: number): number {
  return Math.max(CANVAS_PORT_HIT_BASE_PX, CANVAS_PORT_MIN_SCREEN_PX * canvasZoomInverse(zoom))
}

export function applyCanvasZoomInverse(
  element: CanvasZoomVariableTarget | null,
  zoom: number
): void {
  element?.style.setProperty('--canvas-zoom-inverse', String(canvasZoomInverse(zoom)))
}
