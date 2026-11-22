import {
  PORT_HIT_RADIUS_SCREEN,
  safeTriangleFromAnchor,
  type AnchorHitCandidate,
  type CanvasHitCandidate,
  type CanvasPoint,
  type CanvasRect
} from './hitArbitration'

export type CanvasHitAttribution = {
  kind: 'port' | 'anchor'
  id: string
}

export type CanvasHitTarget = {
  candidate: CanvasHitCandidate
  element: HTMLElement
}

const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"]'

function screenRectOf(rect: DOMRect): CanvasRect | null {
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null
  if (rect.width <= 0 || rect.height <= 0) return null
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

function centerOf(rect: CanvasRect): CanvasPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function nodeRectOf(element: Element): CanvasRect | null {
  const rect = element.closest('.react-flow__node')?.getBoundingClientRect()
  return rect ? screenRectOf(rect) : null
}

const RECORD_HANDLE_SELECTOR =
  '.react-flow__handle[aria-label="装载关系记录"], .react-flow__handle[data-handleid="record"], .react-flow__handle:not([data-port-key])'

function recordHandleOf(element: Element): HTMLElement | null {
  const node = element.closest('.react-flow__node')
  if (!node) return null
  const handle = node.querySelector<HTMLElement>(RECORD_HANDLE_SELECTOR)
  if (!handle || handle.matches('[data-port-key]')) return null
  return handle
}

function nearestCardCenter(
  point: CanvasPoint,
  cardRects: readonly CanvasRect[]
): CanvasPoint | null {
  let nearest: CanvasPoint | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const rect of cardRects) {
    const center = centerOf(rect)
    const distance = Math.hypot(center.x - point.x, center.y - point.y)
    if (distance < nearestDistance) {
      nearest = center
      nearestDistance = distance
    }
  }
  return nearest
}

export function collectCanvasHitTargets(root: HTMLElement | null): CanvasHitTarget[] {
  if (!root) return []
  const targets: CanvasHitTarget[] = []
  const cardRects: CanvasRect[] = []

  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-port-key]'))) {
    const id = element.dataset.portKey
    const rect = screenRectOf(element.getBoundingClientRect())
    if (!id || !rect) continue
    const cardRect = nodeRectOf(element)
    if (cardRect) cardRects.push(cardRect)
    targets.push({
      element,
      candidate: {
        kind: 'port',
        id,
        center: centerOf(rect),
        radius: PORT_HIT_RADIUS_SCREEN
      }
    })
  }

  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-anchor-id]'))) {
    const id = element.dataset.anchorId
    if (!id) continue
    const dot = element.querySelector<HTMLElement>('[data-anchor-dot]') ?? element
    const dotRect = screenRectOf(dot.getBoundingClientRect())
    if (!dotRect) continue
    const center = centerOf(nodeRectOf(element) ?? dotRect)
    const labelArea = screenRectOf(element.getBoundingClientRect())
    const recordHandle = recordHandleOf(element)
    const recordHandleArea = recordHandle
      ? screenRectOf(recordHandle.getBoundingClientRect())
      : null
    const candidate: AnchorHitCandidate = {
      kind: 'anchor',
      id,
      center,
      area: dotRect,
      triangle: safeTriangleFromAnchor(center, nearestCardCenter(center, cardRects)),
      ...(labelArea ? { labelArea } : {}),
      ...(recordHandle && recordHandleArea
        ? { recordHandleArea, recordHandleElement: recordHandle }
        : {})
    }
    targets.push({ element, candidate })
  }

  return targets
}

export function canvasHitAttributionOf(target: Element | null): CanvasHitAttribution | null {
  if (!target) return null
  const port = target.closest<HTMLElement>('[data-port-key]')
  if (port?.dataset.portKey) return { kind: 'port', id: port.dataset.portKey }
  const anchor = target.closest<HTMLElement>('[data-anchor-id]')
  if (anchor?.dataset.anchorId) return { kind: 'anchor', id: anchor.dataset.anchorId }
  return null
}

export function isInteractiveCanvasElement(target: Element): boolean {
  return Boolean(target.closest(INTERACTIVE_SELECTOR))
}

export function forwardCanvasHitEvent(event: MouseEvent, element: HTMLElement): void {
  element.dispatchEvent(
    new MouseEvent(event.type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      button: event.button,
      buttons: event.buttons
    })
  )
}
