import { CANVAS_PORT_MIN_SCREEN_PX } from './canvasZoomHitArea'

export const PORT_HIT_RADIUS_SCREEN = CANVAS_PORT_MIN_SCREEN_PX / 2

export const SAFE_TRIANGLE_LENGTH_SCREEN = 24
export const SAFE_TRIANGLE_HALF_WIDTH_SCREEN = 10

export const ARBITRATION_MAX_ZOOM = 0.6

export const PORT_CENTER_BULLSEYE_SCREEN = 2

export const SAME_GESTURE_TOLERANCE_SCREEN = 1

export type CanvasPoint = { x: number; y: number }

export type CanvasRect = { x: number; y: number; width: number; height: number }

export type SafeTriangle = {
  apex: CanvasPoint
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
  center: CanvasPoint
  area: CanvasRect
  labelArea?: CanvasRect
  recordHandleArea?: CanvasRect
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

export function shouldArbitrateCanvasHit(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom > 0 && zoom <= ARBITRATION_MAX_ZOOM
}

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

export function pointInAnchorGlyph(point: CanvasPoint, anchor: AnchorHitCandidate): boolean {
  return isFinitePoint(point) && rectContains(anchor.area, point)
}

function anchorContainerContains(point: CanvasPoint, anchor: AnchorHitCandidate): boolean {
  if (hitCandidateContains(point, anchor)) return true
  if (anchor.labelArea && rectContains(anchor.labelArea, point)) return true
  if (anchor.recordHandleArea && rectContains(anchor.recordHandleArea, point)) return true
  return false
}

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

export function shouldForwardClickAtRedirectedPress(
  press: CanvasPoint | null,
  click: CanvasPoint,
  toleranceScreen: number = SAME_GESTURE_TOLERANCE_SCREEN
): boolean {
  if (!press || !isFinitePoint(press) || !isFinitePoint(click)) return false
  if (!Number.isFinite(toleranceScreen) || toleranceScreen < 0) return false
  return Math.hypot(click.x - press.x, click.y - press.y) <= toleranceScreen
}
