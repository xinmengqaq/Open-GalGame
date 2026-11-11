import { describe, expect, it } from 'vitest'

import { resolveCardSpacing, type CardSpacingMove } from '@presentation/features/scene-canvas/cardSpacing'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'

function documentCard(
  cardId: string,
  x: number,
  y: number,
  width = 300,
  height = 224
): SessionCard {
  return {
    kind: 'document',
    cardId,
    sourceId: `source-${cardId}`,
    title: cardId,
    summary: '',
    layout: { x, y, width, height }
  }
}

function applyMoves(
  cards: readonly SessionCard[],
  moves: readonly { cardId: string; x: number; y: number }[]
): SessionCard[] {
  const byId = new Map(moves.map((move) => [move.cardId, move]))
  return cards.map((card) => {
    const move = byId.get(card.cardId)
    return move ? { ...card, layout: { ...card.layout, x: move.x, y: move.y } } : card
  })
}

describe('卡片隔离间距', () => {
  it('水平间隙不足 32 时把后一张向右弹到 32', () => {
    const cards = [documentCard('a', 0, 0), documentCard('b', 320, 0)]
    expect(resolveCardSpacing(cards)).toEqual([{ cardId: 'b', x: 332, y: 0 }])
  })

  it('正好 32 或更远时不动', () => {
    expect(
      resolveCardSpacing([documentCard('a', 0, 0), documentCard('b', 332, 0)])
    ).toEqual([])
    expect(
      resolveCardSpacing([documentCard('a', 0, 0), documentCard('b', 400, 40)])
    ).toEqual([])
  })

  it('垂直间隙不足 32 时向下弹开', () => {
    const cards = [documentCard('a', 0, 0), documentCard('b', 0, 234)]
    expect(resolveCardSpacing(cards)).toEqual([{ cardId: 'b', x: 0, y: 256 }])
  })

  it('斜向同时不足 32 时沿穿透较浅的轴弹开', () => {
    // 水平间隙 15（穿透 17），垂直间隙 21（穿透 11）：沿垂直轴推开。
    const cards = [documentCard('a', 0, 0), documentCard('b', 315, 245)]
    expect(resolveCardSpacing(cards)).toEqual([{ cardId: 'b', x: 315, y: 256 }])
  })

  it('斜向但已在两个轴上分开 32 以上时不动', () => {
    expect(
      resolveCardSpacing([documentCard('a', 0, 0), documentCard('b', 340, 260)])
    ).toEqual([])
  })

  it('弹开后再次调用返回空数组（幂等）', () => {
    const cards = [documentCard('a', 0, 0), documentCard('b', 320, 0)]
    const moved = applyMoves(cards, resolveCardSpacing(cards))
    expect(resolveCardSpacing(moved)).toEqual([])
  })

  it('输入顺序不影响结果（按 y、x、cardId 稳定处理）', () => {
    const a = documentCard('a', 0, 0)
    const b = documentCard('b', 320, 0)
    const c = documentCard('c', 640, 0)
    const forward = resolveCardSpacing([a, b, c])
    const backward = resolveCardSpacing([c, b, a])
    const byId = (moves: CardSpacingMove[]): CardSpacingMove[] =>
      [...moves].sort((left, right) => left.cardId.localeCompare(right.cardId))
    expect(byId(backward)).toEqual(byId(forward))
    expect(byId(forward)).toEqual([
      { cardId: 'b', x: 332, y: 0 },
      { cardId: 'c', x: 664, y: 0 }
    ])
  })

  it('小数坐标只输出整数位置，且取整后仍满足 32 间距', () => {
    const cards = [documentCard('a', 0, 0), documentCard('b', 320.6, 0)]
    const moves = resolveCardSpacing(cards)
    expect(moves).toEqual([{ cardId: 'b', x: 332, y: 0 }])
    const moved = applyMoves(cards, moves)
    expect(resolveCardSpacing(moved)).toEqual([])
  })

  it('达到轮数上限即停止，不越过上限继续扫描', () => {
    const cards = [documentCard('a', 0, 0), documentCard('b', 320, 0)]
    expect(resolveCardSpacing(cards, { maxRounds: 0 })).toEqual([])
  })

  it('密集重叠的多张卡会全部弹开且坐标保持整数', () => {
    const cards = Array.from({ length: 6 }, (_unused, index) =>
      documentCard(`card-${index}`, 0, 0)
    )
    const moves = resolveCardSpacing(cards)
    expect(moves.length).toBeGreaterThan(0)
    for (const move of moves) {
      expect(Number.isInteger(move.x)).toBe(true)
      expect(Number.isInteger(move.y)).toBe(true)
    }
    expect(resolveCardSpacing(applyMoves(cards, moves))).toEqual([])
  })
})
