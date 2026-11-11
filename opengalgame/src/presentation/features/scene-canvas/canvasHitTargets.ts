/**
 * 画布命中仲裁的 DOM 适配层：只负责把屏幕上的端口与锚点读成候选，
 * 并在归属不一致时把鼠标事件转发给解析出的元素。仲裁规则见 hitArbitration.ts。
 */

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

/** 可保留自身交互的元素；没有命中端口/锚点时，不抢这些元素的点击。 */
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

/** 记录装载 handle：优先按 aria-label / handleid 找，再退到节点内任意非端口 handle。 */
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

/**
 * 读取画布内的全部端口与锚点候选。任一元素尺寸为零或坐标缺失时跳过该项；
 * 一个都读不到时返回空数组，调用方放弃介入。
 */
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
    // hover 展开标签会把光点本身平移，锚点节点矩形不随展开变化，用它的中心当稳定锚点中心。
    const center = centerOf(nodeRectOf(element) ?? dotRect)
    const labelArea = screenRectOf(element.getBoundingClientRect())
    // 记录装载 handle 也是锚点容器的一部分：低缩放时相邻锚点的 handle 会互相叠压。
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

/** 事件实际落点归属的端口或锚点；落在卡片、画布空白处时返回 null。 */
export function canvasHitAttributionOf(target: Element | null): CanvasHitAttribution | null {
  if (!target) return null
  const port = target.closest<HTMLElement>('[data-port-key]')
  if (port?.dataset.portKey) return { kind: 'port', id: port.dataset.portKey }
  const anchor = target.closest<HTMLElement>('[data-anchor-id]')
  if (anchor?.dataset.anchorId) return { kind: 'anchor', id: anchor.dataset.anchorId }
  return null
}

/** 落点自身带既有交互（按钮、链接等），不要为了命中补偿抢走它。 */
export function isInteractiveCanvasElement(target: Element): boolean {
  return Boolean(target.closest(INTERACTIVE_SELECTOR))
}

/** 向解析出的元素派发同坐标、同按键状态的鼠标事件，保住 React Flow 的连线起手。 */
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
