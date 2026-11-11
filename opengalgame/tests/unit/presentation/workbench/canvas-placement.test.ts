import { describe, expect, it } from 'vitest'

import {
  findFreeCanvasPosition,
  intersectsAnyCard
} from '@presentation/features/scene-canvas/canvasPlacement'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'

const size = { width: 320, height: 208 }

function imageCard(
  cardId: string,
  x: number,
  y: number,
  width = size.width,
  height = size.height
): SessionCard {
  return {
    kind: 'image',
    cardId,
    sourceId: `source-${cardId}`,
    title: cardId,
    summary: '',
    layout: { x, y, width, height }
  }
}

describe('画布新卡片放置', () => {
  it('空画布直接使用首选位置', () => {
    expect(findFreeCanvasPosition([], { x: 40, y: 60 }, size)).toEqual({
      position: { x: 40, y: 60 },
      overlapping: false
    })
  })

  it('首选位置被占用时向右寻找空闲位', () => {
    const cards = [imageCard('first', 40, 60)]
    expect(findFreeCanvasPosition(cards, { x: 40, y: 60 }, size)).toEqual({
      position: { x: 392, y: 60 },
      overlapping: false
    })
  })

  it('同一行占满后换到下一行', () => {
    const cards = [
      imageCard('first', 40, 60),
      imageCard('second', 392, 60),
      imageCard('third', 744, 60)
    ]
    expect(findFreeCanvasPosition(cards, { x: 40, y: 60 }, size)).toEqual({
      position: { x: 40, y: 300 },
      overlapping: false
    })
  })

  it('所有网格槽位被占用时继续向下寻找空位', () => {
    const cards: SessionCard[] = []
    for (let row = 0; row < 24; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        cards.push(imageCard(`card-${row}-${column}`, 40 + column * 352, 60 + row * 240))
      }
    }
    expect(findFreeCanvasPosition(cards, { x: 40, y: 60 }, size)).toEqual({
      position: { x: 40, y: 5820 },
      overlapping: false
    })
  })

  it('超过可用深度的列不再使用，全部超限时明确标记重叠', () => {
    const cards = [
      imageCard('left', 40, 60, 320, 13000),
      imageCard('middle', 392, 60, 320, 13000),
      imageCard('right', 744, 60, 320, 13000)
    ]
    expect(findFreeCanvasPosition(cards, { x: 40, y: 60 }, size)).toEqual({
      position: { x: 40, y: 60 },
      overlapping: true
    })
  })

  it('相隔一个间距的卡片不算重叠', () => {
    const candidate = { x: 40, y: 60, ...size }
    const cards = [imageCard('right', 392, 60)]
    expect(intersectsAnyCard(candidate, cards)).toBe(false)
  })
})
