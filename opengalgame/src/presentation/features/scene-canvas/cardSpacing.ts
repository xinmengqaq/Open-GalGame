import type { SessionCard } from '../workbench-session/workbenchSession.types'

import { CANVAS_PLACEMENT_GAP } from './canvasPlacement'

/** 一轮最多把整张画布扫几遍；兜底防止极端布局在弹开时来回振荡。 */
export const CARD_SPACING_MAX_ROUNDS = 8

export interface CardSpacingMove {
  cardId: string
  x: number
  y: number
}

export interface CardSpacingOptions {
  /** 卡片之间的最小间距（flow px），默认沿用画布放置间距 32。 */
  gap?: number
  /** 最多扫描轮数，默认 {@link CARD_SPACING_MAX_ROUNDS}。 */
  maxRounds?: number
}

interface WorkingCard {
  cardId: string
  x: number
  y: number
  width: number
  height: number
  originalX: number
  originalY: number
  inputIndex: number
}

function horizontalGap(a: WorkingCard, b: WorkingCard): number {
  return Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)
}

function verticalGap(a: WorkingCard, b: WorkingCard): number {
  return Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)
}

/**
 * 把互相重叠、或水平/垂直间隙同时小于 `gap` 的卡片按阅读顺序弹开。
 *
 * 处理顺序固定为 (y, x, cardId)，同一对卡片只移动排序靠后的那张：比较两个轴的
 * 穿透深度，沿穿透较浅的轴朝远离前一张卡的方向推到恰好 `gap`。坐标取整时向外取
 * （右/下用 ceil，左/上用 floor），保证取整后不会重新掉回不足 `gap` 的状态，
 * 因此对同一结果再调用一次必定返回空数组。
 *
 * 输入已满足间距时返回 `[]`；只返回位置发生变化的卡片，尺寸不变。
 */
export function resolveCardSpacing(
  cards: readonly SessionCard[],
  options: CardSpacingOptions = {}
): CardSpacingMove[] {
  const gap = options.gap ?? CANVAS_PLACEMENT_GAP
  const maxRounds = options.maxRounds ?? CARD_SPACING_MAX_ROUNDS
  if (!Number.isFinite(gap) || gap < 0 || !Number.isFinite(maxRounds) || maxRounds <= 0) {
    return []
  }
  if (cards.length < 2) {
    return []
  }

  const working: WorkingCard[] = cards.map((card, inputIndex) => ({
    cardId: card.cardId,
    x: card.layout.x,
    y: card.layout.y,
    width: card.layout.width,
    height: card.layout.height,
    originalX: card.layout.x,
    originalY: card.layout.y,
    inputIndex
  }))
  if (working.some((card) => !Number.isFinite(card.x) || !Number.isFinite(card.y))) {
    return []
  }

  // 仅用于两两扫描的稳定顺序；返回值仍按调用方传入顺序排列。
  const ordered = [...working].sort(
    (a, b) =>
      a.y - b.y ||
      a.x - b.x ||
      (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0) ||
      a.inputIndex - b.inputIndex
  )

  for (let round = 0; round < maxRounds; round += 1) {
    let changed = false
    for (let ahead = 0; ahead < ordered.length; ahead += 1) {
      for (let behind = ahead + 1; behind < ordered.length; behind += 1) {
        const first = ordered[ahead]
        const later = ordered[behind]
        const acrossGap = horizontalGap(first, later)
        const downGap = verticalGap(first, later)
        if (acrossGap >= gap || downGap >= gap) {
          continue
        }

        const acrossPenetration = gap - acrossGap
        const downPenetration = gap - downGap
        const previousX = later.x
        const previousY = later.y
        if (acrossPenetration <= downPenetration) {
          later.x =
            later.x + later.width / 2 >= first.x + first.width / 2
              ? Math.ceil(first.x + first.width + gap)
              : Math.floor(first.x - later.width - gap)
        } else {
          later.y =
            later.y + later.height / 2 >= first.y + first.height / 2
              ? Math.ceil(first.y + first.height + gap)
              : Math.floor(first.y - later.height - gap)
        }
        if (later.x !== previousX || later.y !== previousY) {
          changed = true
        }
      }
    }
    if (!changed) {
      break
    }
  }

  const moves: CardSpacingMove[] = []
  for (const card of working) {
    const x = Math.round(card.x)
    const y = Math.round(card.y)
    if (x !== Math.round(card.originalX) || y !== Math.round(card.originalY)) {
      moves.push({ cardId: card.cardId, x, y })
    }
  }
  return moves
}
