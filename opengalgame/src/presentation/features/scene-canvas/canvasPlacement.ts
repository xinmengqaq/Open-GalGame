import type { SessionCard } from '../workbench-session/workbenchSession.types'

export type CanvasPoint = { x: number; y: number }
export type CanvasSize = { width: number; height: number }
export type CanvasRect = CanvasPoint & CanvasSize

/** 新卡片与已有卡片之间至少留出的画布间距。 */
export const CANVAS_PLACEMENT_GAP = 32
const PLACEMENT_COLUMNS = 3
const PLACEMENT_MAX_DEPTH = 12000

function intersects(candidate: CanvasRect, existing: CanvasRect, gap: number): boolean {
  return (
    candidate.x < existing.x + existing.width + gap &&
    candidate.x + candidate.width + gap > existing.x &&
    candidate.y < existing.y + existing.height + gap &&
    candidate.y + candidate.height + gap > existing.y
  )
}

export function intersectsAnyCard(
  candidate: CanvasRect,
  cards: readonly SessionCard[],
  gap = CANVAS_PLACEMENT_GAP
): boolean {
  return cards.some((card) => intersects(candidate, card.layout, gap))
}

/** 同一列里向下找到第一个不被已有卡片占用的位置。 */
function freeYInColumn(
  cards: readonly SessionCard[],
  x: number,
  top: number,
  size: CanvasSize
): number {
  let y = top
  for (let step = 0; step < cards.length + 1; step += 1) {
    const blockers = cards.filter((card) =>
      intersects({ x, y, ...size }, card.layout, CANVAS_PLACEMENT_GAP)
    )
    if (blockers.length === 0) return y
    y = Math.ceil(
      Math.max(...blockers.map((card) => card.layout.y + card.layout.height + CANVAS_PLACEMENT_GAP))
    )
  }
  return y
}

/**
 * 在视口锚点附近寻找不与已有卡片重叠的位置。三列向下排布，选最靠上且靠左的空位；
 * 只有整列都超过可用深度时才返回原位并标记重叠，由调用方给出可读提示。
 */
export function findFreeCanvasPosition(
  cards: readonly SessionCard[],
  preferred: CanvasPoint,
  size: CanvasSize
): { position: CanvasPoint; overlapping: boolean } {
  const origin = { x: Math.round(preferred.x), y: Math.round(preferred.y) }
  const preferredPosition = { ...origin }
  if (!intersectsAnyCard({ ...preferredPosition, ...size }, cards)) {
    return { position: preferredPosition, overlapping: false }
  }

  let best: CanvasPoint | null = null
  for (let column = 0; column < PLACEMENT_COLUMNS; column += 1) {
    const x = origin.x + column * (size.width + CANVAS_PLACEMENT_GAP)
    const y = freeYInColumn(cards, x, origin.y, size)
    if (y > origin.y + PLACEMENT_MAX_DEPTH) continue
    if (!best || y < best.y) best = { x, y }
  }
  if (best) return { position: best, overlapping: false }
  return { position: preferredPosition, overlapping: true }
}
