import { describe, expect, it } from 'vitest'

import {
  anchorHitClearance,
  anchorsFromRelations,
  edgesFromRelations,
  nodesFromCards,
  recordEdgesFromRelations
} from '@presentation/features/scene-canvas/sceneCanvasLayout'
import type {
  SessionCard,
  SessionDocumentCard,
  SessionRelation
} from '@presentation/features/workbench-session/workbenchSession.types'
import type { RelationAnchorNode } from '@presentation/features/scene-canvas/sceneCanvas.types'

function documentCard(cardId: string, x: number, y: number): SessionDocumentCard {
  return {
    kind: 'document',
    cardId,
    sourceId: `${cardId}-source`,
    title: `${cardId} 标题`,
    summary: '',
    layout: { x, y, width: 300, height: 224 }
  }
}

function relationOf(recordCardId: string | null): SessionRelation {
  return {
    relationId: 'relation-1',
    fromCardId: 'card-a',
    toCardId: 'card-b',
    specificName: '',
    recordCardId
  }
}

function fixture(): { cards: SessionCard[]; relations: SessionRelation[] } {
  return {
    cards: [
      documentCard('card-a', 0, 0),
      documentCard('card-b', 600, 0),
      documentCard('record-card', 300, 480)
    ],
    relations: [relationOf('record-card')]
  }
}

type CardLayout = { x: number; y: number; width: number; height: number }

function cardWithLayout(cardId: string, layout: CardLayout): SessionDocumentCard {
  return { ...documentCard(cardId, layout.x, layout.y), layout }
}

function labelDataWithBlocker(blocker: CardLayout | null): RelationAnchorNode['data'] {
  const cards: SessionCard[] = [documentCard('card-a', 0, 0), documentCard('card-b', 600, 0)]
  if (blocker) cards.push(cardWithLayout('blocker-card', blocker))
  const relations: SessionRelation[] = [{ ...relationOf(null), specificName: '同班同学' }]
  const [anchor] = anchorsFromRelations(cards, relations, nodesFromCards(cards))
  if (!anchor) throw new Error('关系锚点缺失')
  return anchor.data
}

describe('关系锚点记录边布局', () => {
  it('关系锚点声明与节点组件一致的 record target handle', () => {
    const { cards, relations } = fixture()
    const anchors = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    expect(anchors).toHaveLength(1)
    const [anchor] = anchors
    expect(anchor?.id).toBe('relation-anchor:relation-1')
    expect(anchor?.type).toBe('relationAnchor')
    expect(anchor?.handles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'record', type: 'target' })])
    )
  })

  it('每个关系锚点都带 measured，节点初始化才能成立', () => {
    const { cards } = fixture()
    const relations: SessionRelation[] = [
      relationOf('record-card'),
      { ...relationOf(null), relationId: 'relation-2' }
    ]
    const anchors = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) {
      expect(anchor.measured).toEqual({ width: 1, height: 1 })
    }
  })

  it('带记录的关系产出一条从记录卡指向关系锚点的记录边', () => {
    const { cards, relations } = fixture()
    const anchors = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    const recordEdges = recordEdgesFromRelations(cards, relations, anchors)

    expect(recordEdges).toHaveLength(1)
    expect(recordEdges[0]).toMatchObject({
      id: 'record-link:relation-1',
      type: 'recordLink',
      source: 'record-card',
      target: 'relation-anchor:relation-1',
      targetHandle: 'record',
      data: { relationId: 'relation-1' }
    })
  })

  it('记录边与普通 session 边同时进入渲染数据，普通边不被过滤', () => {
    const { cards, relations } = fixture()
    const anchors = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    const associationEdges = edgesFromRelations(cards, relations)
    const recordEdges = recordEdgesFromRelations(cards, relations, anchors)
    const allEdges = [...associationEdges, ...recordEdges]

    expect(associationEdges).toHaveLength(1)
    expect(associationEdges[0]).toMatchObject({
      id: 'relation-1',
      type: 'sessionAssociation',
      source: 'card-a',
      target: 'card-b'
    })
    expect(allEdges.map((edge) => edge.type)).toEqual(['sessionAssociation', 'recordLink'])
  })

  it('没有记录的关系不产出记录边，普通 session 边照常', () => {
    const { cards } = fixture()
    const relations = [relationOf(null)]
    const anchors = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    expect(recordEdgesFromRelations(cards, relations, anchors)).toHaveLength(0)
    expect(edgesFromRelations(cards, relations)).toHaveLength(1)
  })
})

describe('关系标签抬升档位', () => {
  it('线上方没有卡片时落在最近的抬升档，不收起', () => {
    const data = labelDataWithBlocker(null)

    expect(data.labelLift).toBe(36)
    expect(data.condensed).toBeFalsy()
  })

  it('近档被卡片占住时取下一个空档，而不是直接收起', () => {
    const data = labelDataWithBlocker({ x: 380, y: 75, width: 320, height: 25 })

    expect(data.labelLift).toBe(62)
    expect(data.condensed).toBeFalsy()
  })

  it.each([
    ['36 与 62 档', { x: 380, y: 60, width: 320, height: 20 }, 88],
    ['36、62 与 88 档', { x: 380, y: 23, width: 320, height: 77 }, 114],
    ['36、62、88 与 114 档', { x: 380, y: -3, width: 320, height: 103 }, 140]
  ] as const)('%s被卡片占住时抬到 %i 档', (_label, blocker, expected) => {
    const data = labelDataWithBlocker(blocker)

    expect(data.labelLift).toBe(expected)
    expect(data.condensed).toBeFalsy()
  })

  it('所有档位都被卡片占住时收起为光点', () => {
    const data = labelDataWithBlocker({ x: 380, y: -100, width: 320, height: 300 })

    expect(data.labelLift).toBe(0)
    expect(data.condensed).toBe(true)
  })
})

describe('关系锚点命中盒收窄', () => {
  it('game1 的两个近距锚点按方形安全距离收窄，轴对齐命中盒不再叠压', () => {
    const first = { x: 736, y: 488 }
    const second = { x: 752, y: 494.5 }
    const farPort = { x: 1600, y: 1200 }

    const clearanceFirst = anchorHitClearance(first, [second], [farPort])
    const clearanceSecond = anchorHitClearance(second, [first], [farPort])
    const dx = Math.abs(second.x - first.x)
    const dy = Math.abs(second.y - first.y)

    expect(Math.max(dx, dy)).toBe(16)
    expect(clearanceFirst).toBe(15)
    expect(clearanceSecond).toBe(15)
    expect((clearanceFirst + clearanceSecond) / 2).toBeLessThan(dx)
  })

  it('端口中心落在锚点命中盒之外', () => {
    const clearance = anchorHitClearance({ x: 100, y: 100 }, [], [{ x: 120, y: 100 }])

    expect(clearance).toBe(19)
    expect(20).toBeGreaterThan(clearance / 2)
  })

  it('标签抬升后按实际渲染中心收窄，命中盒不会压住下方端口', () => {
    const cards: SessionCard[] = [
      documentCard('card-a', 0, 0),
      documentCard('card-b', 600, 0),
      cardWithLayout('blocker-card', { x: 150, y: 0, width: 300, height: 224 })
    ]
    const relations: SessionRelation[] = [{ ...relationOf(null), specificName: '同班同学' }]
    const [anchor] = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    expect(anchor?.data.labelLift).toBe(140)
    const style = anchor?.style as Record<string, unknown> | undefined
    expect(style?.['--anchor-hit-clearance']).toBe('139px')
  })

  it('没有其它锚点与端口时返回哨兵值，命中盒只受屏幕缩放限制', () => {
    expect(anchorHitClearance({ x: 10, y: 20 }, [], [])).toBe(100000)
  })

  it('每个关系锚点的 style 都写入有效的命中盒收窄变量', () => {
    const { cards } = fixture()
    const relations: SessionRelation[] = [
      relationOf('record-card'),
      {
        relationId: 'relation-2',
        fromCardId: 'card-b',
        toCardId: 'record-card',
        specificName: '',
        recordCardId: null
      }
    ]

    const anchors = anchorsFromRelations(cards, relations, nodesFromCards(cards))

    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) {
      const style = anchor.style as Record<string, unknown> | undefined
      const clearance = style?.['--anchor-hit-clearance']
      expect(typeof clearance).toBe('string')
      expect(clearance).toMatch(/^\d+(\.\d+)?px$/)
      const value = Number.parseFloat(String(clearance))
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThan(100000)
    }
    expect(anchors[0]?.style?.width).toBe(1)
    expect(anchors[0]?.style?.height).toBe(1)
  })
})
