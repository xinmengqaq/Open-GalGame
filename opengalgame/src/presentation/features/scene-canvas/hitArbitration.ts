/**
 * 画布低缩放命中仲裁：端口热区、锚点可见光点与锚点安全三角互相叠压时，
 * 先筛出覆盖点击位置的候选，再按到候选中心的距离归属，避免端口中心被锚点抢走。
 * 纯函数，屏幕坐标输入输出，可在 node 环境单测。
 */

import { CANVAS_PORT_MIN_SCREEN_PX } from './canvasZoomHitArea'

/** 端口热区的屏幕半径；与 CSS 中 28px 屏幕热区的半宽一致。 */
export const PORT_HIT_RADIUS_SCREEN = CANVAS_PORT_MIN_SCREEN_PX / 2

/** 锚点安全三角的屏幕长度与半宽：从锚点中心朝卡片内侧补偿一块可点区域。 */
export const SAFE_TRIANGLE_LENGTH_SCREEN = 24
export const SAFE_TRIANGLE_HALF_WIDTH_SCREEN = 10

/** 只在适配画布的低缩放档启用仲裁，正常缩放不抢卡片点击。 */
export const ARBITRATION_MAX_ZOOM = 0.6

/** 端口中心命中容差：点击点离端口中心不超过该屏幕像素时一律归端口。 */
export const PORT_CENTER_BULLSEYE_SCREEN = 2

/**
 * 同手势容差：浏览器在 drag 完成边后会补发一次 click，只有该 click 与一次被重定向的
 * mousedown 落在同一点（同一手势）时才允许继续转发。
 */
export const SAME_GESTURE_TOLERANCE_SCREEN = 1

export type CanvasPoint = { x: number; y: number }

/** 屏幕矩形：与 getBoundingClientRect 的 left/top/width/height 对应。 */
export type CanvasRect = { x: number; y: number; width: number; height: number }

export type SafeTriangle = {
  /** 三角顶点：锚点可见中心。 */
  apex: CanvasPoint
  /** 单位方向：从锚点中心指向卡片内部。 */
  direction: CanvasPoint
  length: number
  halfWidth: number
}

export type PortHitCandidate = {
  kind: 'port'
  id: string
  center: CanvasPoint
  radius: number
}

export type AnchorHitCandidate = {
  kind: 'anchor'
  id: string
  /**
   * 锚点中心的稳定几何：锚点节点矩形中心，不随 hover 展开标签而平移。
   * 光点本身的位置另见 area（展开时会被左移）。
   */
  center: CanvasPoint
  /** 可见光点的屏幕盒；安全三角之外仍保证光点本身可命中。 */
  area: CanvasRect
  /** 锚点可见标签的屏幕矩形（展开后就是文字标签本体）；用于保护标签点击。 */
  labelArea?: CanvasRect
  /** 记录装载 handle 的屏幕矩形：低缩放下多个锚点 handle 会叠压，用于容器隔离。 */
  recordHandleArea?: CanvasRect
  /** 记录装载 handle 元素：容器隔离后把鼠标事件转给它。 */
  recordHandleElement?: Element
  triangle: SafeTriangle
}

export type CanvasHitCandidate = PortHitCandidate | AnchorHitCandidate

function isFinitePoint(point: CanvasPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function rectContains(rect: CanvasRect, point: CanvasPoint): boolean {
  return (
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0 &&
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** 低缩放仲裁开关：非法缩放、正常缩放与放大档都不介入。 */
export function shouldArbitrateCanvasHit(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom > 0 && zoom <= ARBITRATION_MAX_ZOOM
}

/**
 * 以锚点可见中心为顶点、朝卡片内部方向建安全三角。
 * 卡片位置缺失或与锚点重合时退化为零方向，三角不扩张，只保留光点自身命中区。
 */
export function safeTriangleFromAnchor(
  center: CanvasPoint,
  interior: CanvasPoint | null,
  length: number = SAFE_TRIANGLE_LENGTH_SCREEN,
  halfWidth: number = SAFE_TRIANGLE_HALF_WIDTH_SCREEN
): SafeTriangle {
  const dx = interior ? interior.x - center.x : 0
  const dy = interior ? interior.y - center.y : 0
  const distance = Math.hypot(dx, dy)
  return {
    apex: { x: center.x, y: center.y },
    direction:
      distance > 0.001 ? { x: dx / distance, y: dy / distance } : { x: 0, y: 0 },
    length,
    halfWidth
  }
}

function edgeSign(first: CanvasPoint, second: CanvasPoint, point: CanvasPoint): number {
  return (
    (point.x - second.x) * (first.y - second.y) -
    (first.x - second.x) * (point.y - second.y)
  )
}

/** 点是否落在安全三角内（含边界）。 */
export function pointInSafeTriangle(point: CanvasPoint, triangle: SafeTriangle): boolean {
  const { apex, direction, length, halfWidth } = triangle
  if (!isFinitePoint(point) || !isFinitePoint(apex) || !isFinitePoint(direction)) return false
  if (!Number.isFinite(length) || !Number.isFinite(halfWidth)) return false
  if (length <= 0 || halfWidth <= 0) return false
  if (Math.hypot(direction.x, direction.y) < 0.5) return false

  const base = {
    x: apex.x + direction.x * length,
    y: apex.y + direction.y * length
  }
  const perpendicular = { x: -direction.y, y: direction.x }
  const left = {
    x: base.x + perpendicular.x * halfWidth,
    y: base.y + perpendicular.y * halfWidth
  }
  const right = {
    x: base.x - perpendicular.x * halfWidth,
    y: base.y - perpendicular.y * halfWidth
  }

  const first = edgeSign(apex, left, point)
  const second = edgeSign(left, right, point)
  const third = edgeSign(right, apex, point)
  const hasNegative = first < 0 || second < 0 || third < 0
  const hasPositive = first > 0 || second > 0 || third > 0
  return !(hasNegative && hasPositive)
}

/** 候选自身的命中区是否覆盖该点。 */
export function hitCandidateContains(point: CanvasPoint, candidate: CanvasHitCandidate): boolean {
  if (!isFinitePoint(point)) return false
  if (candidate.kind === 'port') {
    if (!Number.isFinite(candidate.radius) || candidate.radius < 0) return false
    return (
      Math.hypot(point.x - candidate.center.x, point.y - candidate.center.y) <= candidate.radius
    )
  }
  return rectContains(candidate.area, point) || pointInSafeTriangle(point, candidate.triangle)
}

/** 点是否落在锚点可见光点本身（不含朝卡片内侧的安全三角）。 */
export function pointInAnchorGlyph(point: CanvasPoint, anchor: AnchorHitCandidate): boolean {
  return isFinitePoint(point) && rectContains(anchor.area, point)
}

/** 锚点容器并集：光点盒、安全三角、展开标签、记录装载 handle 都视为该锚点的领地。 */
function anchorContainerContains(point: CanvasPoint, anchor: AnchorHitCandidate): boolean {
  if (hitCandidateContains(point, anchor)) return true
  if (anchor.labelArea && rectContains(anchor.labelArea, point)) return true
  if (anchor.recordHandleArea && rectContains(anchor.recordHandleArea, point)) return true
  return false
}

/**
 * 多个关系锚点的命中容器叠压时（低缩放常见：记录装载 handle 会盖住相邻锚点），
 * 在覆盖点击点的锚点容器中取稳定中心最近者；同距时优先事件实际落点的锚点。
 * 没有容器覆盖该点时返回 null，调用方保持原有的放行行为。
 */
export function resolveAnchorContainerTarget(
  point: CanvasPoint,
  anchors: readonly AnchorHitCandidate[],
  actualRelationId?: string
): AnchorHitCandidate | null {
  if (!isFinitePoint(point)) return null
  let best: AnchorHitCandidate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const anchor of anchors) {
    if (!anchorContainerContains(point, anchor)) continue
    if (!isFinitePoint(anchor.center)) continue
    const distance = Math.hypot(point.x - anchor.center.x, point.y - anchor.center.y)
    if (!Number.isFinite(distance)) continue
    const tieWithActual =
      distance === bestDistance && anchor.id === actualRelationId && best?.id !== actualRelationId
    if (!best || distance < bestDistance || tieWithActual) {
      best = anchor
      bestDistance = distance
    }
  }
  return best
}

/**
 * drag 装载的锚点纠正：React Flow 的拖拽 target 在 pointermove 期由
 * `document.elementFromPoint` 决定（低缩放下叠压的宽 handle 会优先命中），松手时只消费
 * 最后一次结果，不经过视口的 mousedown/click 转发。这里用松手点重新做一次锚点容器裁决：
 * 缩放不在低缩放档、落点缺失、target 不是关系锚点、或裁决结果与 React Flow 一致时返回
 * null，调用方保持原连接；否则返回应改投的关系锚点 id。
 */
export function correctAnchorConnectTarget(
  point: CanvasPoint | null,
  actualRelationId: string | null,
  anchors: readonly AnchorHitCandidate[],
  zoom: number
): string | null {
  if (!point || !isFinitePoint(point) || !actualRelationId) return null
  if (!shouldArbitrateCanvasHit(zoom)) return null
  const winner = resolveAnchorContainerTarget(point, anchors, actualRelationId)
  if (!winner || winner.id === actualRelationId) return null
  return winner.id
}

/**
 * 低缩放仲裁的转派判定：事件实际落在锚点元素上、解析结果却是端口时：
 * 1. 端口中心 bullseye 内（<= PORT_CENTER_BULLSEYE_SCREEN）一律转派，保住端口中心起连；
 * 2. 其余按到端口中心与锚点稳定中心的距离裁决，端口更近才转派。
 * 低缩放解析出的端口候选只覆盖端口热区，因此转派只会在热区内发生；热区内同样按上述
 * 两条规则裁决：只有 bullseye 内或端口中心比锚点稳定中心更近的点才归端口，锚点光点中心
 * 等离锚点稳定中心更近的位置仍归锚点；热区外的标签由锚点接收。解析结果不是端口时一律
 * 不转派。锚点中心用不随 hover 展开平移的稳定几何。
 */
export function shouldRedirectCanvasHit(
  point: CanvasPoint,
  resolved: CanvasHitCandidate,
  actualAnchor: AnchorHitCandidate
): boolean {
  if (resolved.kind !== 'port') return false
  if (!isFinitePoint(point) || !isFinitePoint(actualAnchor.center)) return false
  const portDistance = Math.hypot(point.x - resolved.center.x, point.y - resolved.center.y)
  if (!Number.isFinite(portDistance)) return false
  if (portDistance <= PORT_CENTER_BULLSEYE_SCREEN) return true
  const anchorDistance = Math.hypot(
    point.x - actualAnchor.center.x,
    point.y - actualAnchor.center.y
  )
  if (!Number.isFinite(anchorDistance)) return false
  return portDistance < anchorDistance
}

/** 距离优先；同距时端口优先；再同距按 id 稳定排序。 */
function compareHitCandidates(
  candidate: CanvasHitCandidate,
  distance: number,
  current: CanvasHitCandidate,
  currentDistance: number
): number {
  if (distance !== currentDistance) return distance - currentDistance
  if (candidate.kind !== current.kind) return candidate.kind === 'port' ? -1 : 1
  if (candidate.id === current.id) return 0
  return candidate.id < current.id ? -1 : 1
}

/**
 * 解析一次点击应归属的端口或锚点。
 * 只有覆盖点击位置的候选参与比较，因此端口中心与锚点中心各自距离为 0，
 * 两个中心都能命中自己；区域外的点击返回 null，不介入。
 */
export function resolveCanvasHit(
  point: CanvasPoint,
  candidates: readonly CanvasHitCandidate[]
): CanvasHitCandidate | null {
  let best: CanvasHitCandidate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (!hitCandidateContains(point, candidate)) continue
    const distance = Math.hypot(point.x - candidate.center.x, point.y - candidate.center.y)
    if (!best || compareHitCandidates(candidate, distance, best, bestDistance) < 0) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * 拖拽完成连线后浏览器补发的 click 是否属于同一次「被重定向的按下」手势。
 * React Flow 的 click 连线第二步依赖 Handle.onClick，而 drag 结束后 mouseup 已清掉
 * click 连线起点；若把补发的 click 转发给端口，Handle.onClick 会把它当成新的
 * click 连线起点，留下 ct=6 的待连接态。只有 press 存在且 click 与它同点
 * （<= toleranceScreen）时才允许继续转发。
 */
export function shouldForwardClickAtRedirectedPress(
  press: CanvasPoint | null,
  click: CanvasPoint,
  toleranceScreen: number = SAME_GESTURE_TOLERANCE_SCREEN
): boolean {
  if (!press || !isFinitePoint(press) || !isFinitePoint(click)) return false
  if (!Number.isFinite(toleranceScreen) || toleranceScreen < 0) return false
  return Math.hypot(click.x - press.x, click.y - press.y) <= toleranceScreen
}
