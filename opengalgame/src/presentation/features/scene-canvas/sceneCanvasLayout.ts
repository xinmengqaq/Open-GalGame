import { getBezierPath, Position } from '@xyflow/react'
import type { CSSProperties } from 'react'

import { isPreviewCard } from '../workbench-session/contentKindLabel'
import { relationLabelOf } from '../workbench-session/workbenchSessionSelectors'
import type { SessionCard, SessionRelation } from '../workbench-session/workbenchSession.types'
import type {
  InputCardNode,
  RecordEdge,
  RelationAnchorNode,
  SessionEdge
} from './sceneCanvas.types'

const RELATION_ANCHOR_PREFIX = 'relation-anchor:'

export function relationAnchorId(relationId: string): string {
  return `${RELATION_ANCHOR_PREFIX}${relationId}`
}

export function isRelationAnchorId(nodeId: string): boolean {
  return nodeId.startsWith(RELATION_ANCHOR_PREFIX)
}

export function relationIdOfAnchor(nodeId: string): string | null {
  return isRelationAnchorId(nodeId) ? nodeId.slice(RELATION_ANCHOR_PREFIX.length) : null
}

export function nodesFromCards(cards: readonly SessionCard[]): InputCardNode[] {
  return cards.map((card) => {
    const preview = isPreviewCard(card.kind)
    const fixedHeight = preview || card.kind === 'prompt'
    return {
      id: card.cardId,
      type: 'inputCard',
      position: { x: card.layout.x, y: card.layout.y },
      data: { cardId: card.cardId },
      width: card.layout.width,
      height: fixedHeight ? card.layout.height : undefined,
      style: fixedHeight
        ? { width: card.layout.width, height: card.layout.height }
        : { width: card.layout.width },
      draggable: true,
      selectable: false,
      focusable: false,
      zIndex: 3
    }
  })
}

type LayoutRef = {
  card: SessionCard
  x: number
  y: number
  width: number
  height: number
}

function layoutOfNode(node: InputCardNode, card: SessionCard): LayoutRef {
  return {
    card,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? node.width ?? card.layout.width,
    height: node.measured?.height ?? node.height ?? card.layout.height
  }
}

function leftToRight(
  first: LayoutRef,
  second: LayoutRef
): { source: LayoutRef; target: LayoutRef } {
  return first.x + first.width / 2 <= second.x + second.width / 2
    ? { source: first, target: second }
    : { source: second, target: first }
}

export function edgesFromRelations(
  cards: readonly SessionCard[],
  relations: readonly SessionRelation[]
): SessionEdge[] {
  const byId = new Map(cards.map((card) => [card.cardId, card]))
  return relations.flatMap((relation) => {
    const from = byId.get(relation.fromCardId)
    const to = byId.get(relation.toCardId)
    if (!from || !to) return []
    const first: LayoutRef = {
      card: from,
      x: from.layout.x,
      y: from.layout.y,
      width: from.layout.width,
      height: from.layout.height
    }
    const second: LayoutRef = {
      card: to,
      x: to.layout.x,
      y: to.layout.y,
      width: to.layout.width,
      height: to.layout.height
    }
    const { source, target } = leftToRight(first, second)
    const label = relationLabelOf({ cards }, relation)
    return [
      {
        id: relation.relationId,
        source: source.card.cardId,
        target: target.card.cardId,
        sourceHandle: 'right',
        targetHandle: 'left',
        type: 'sessionAssociation',
        data: {
          relationId: relation.relationId,
          pending: label.kind === 'empty'
        },
        selectable: false,
        focusable: false,
        deletable: false,
        zIndex: 1
      }
    ]
  })
}

const ANCHOR_HIT_GAP = 1

const ANCHOR_HIT_UNBOUNDED = 100000

export function anchorHitClearance(
  point: { x: number; y: number },
  otherAnchorPoints: readonly { x: number; y: number }[],
  portPoints: readonly { x: number; y: number }[]
): number {
  let nearest = Number.POSITIVE_INFINITY
  for (const other of otherAnchorPoints) {
    const distance = Math.max(Math.abs(other.x - point.x), Math.abs(other.y - point.y))
    nearest = Math.min(nearest, distance)
  }
  for (const port of portPoints) {
    const distance = Math.max(Math.abs(port.x - point.x), Math.abs(port.y - point.y))
    nearest = Math.min(nearest, distance)
  }
  if (!Number.isFinite(nearest)) return ANCHOR_HIT_UNBOUNDED
  return Math.max(1, nearest - ANCHOR_HIT_GAP)
}

function cardPortPoints(layouts: readonly LayoutRef[]): { x: number; y: number }[] {
  return layouts.flatMap((layout) => [
    { x: layout.x, y: layout.y + layout.height / 2 },
    { x: layout.x + layout.width, y: layout.y + layout.height / 2 }
  ])
}

export function anchorsFromRelations(
  cards: readonly SessionCard[],
  relations: readonly SessionRelation[],
  nodes: readonly InputCardNode[]
): RelationAnchorNode[] {
  const cardsById = new Map(cards.map((card) => [card.cardId, card]))
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const placed: Pick<RelationAnchorNode, 'id' | 'position' | 'data'>[] = []
  for (const relation of relations) {
    const from = cardsById.get(relation.fromCardId)
    const to = cardsById.get(relation.toCardId)
    const fromNode = nodesById.get(relation.fromCardId)
    const toNode = nodesById.get(relation.toCardId)
    if (!from || !to || !fromNode || !toNode) continue
    const { source, target } = leftToRight(layoutOfNode(fromNode, from), layoutOfNode(toNode, to))
    const [, labelX, labelY] = getBezierPath({
      sourceX: source.x + source.width,
      sourceY: source.y + source.height / 2,
      sourcePosition: Position.Right,
      targetX: target.x,
      targetY: target.y + target.height / 2,
      targetPosition: Position.Left
    })
    const label = relationLabelOf({ cards }, relation)
    const lift = relationLabelLift(labelX, labelY, label.text, cards)
    const record = relation.recordCardId ? cardsById.get(relation.recordCardId) : undefined
    const recordKind = record?.kind === 'document' || record?.kind === 'prompt' ? record.kind : null
    const recordLabel =
      record?.kind === 'document' ? record.title : record?.kind === 'prompt' ? '提示词记录' : null
    placed.push({
      id: relationAnchorId(relation.relationId),
      position: { x: labelX, y: labelY },
      data: {
        relationId: relation.relationId,
        label: label.text,
        labelKind: label.kind,
        sourceKind: from.kind,
        recordCardId: relation.recordCardId,
        recordLabel,
        recordKind,
        condensed: lift === null,
        labelLift: lift ?? 0
      }
    })
  }

  const portPoints = cardPortPoints(
    cards.map((card) => {
      const node = nodesById.get(card.cardId)
      if (node) return layoutOfNode(node, card)
      return {
        card,
        x: card.layout.x,
        y: card.layout.y,
        width: card.layout.width,
        height: card.layout.height
      }
    })
  )

  const renderedCenter = (
    anchor: Pick<RelationAnchorNode, 'position' | 'data'>
  ): { x: number; y: number } => ({
    x: anchor.position.x,
    y: anchor.position.y - (anchor.data.labelLift ?? 0)
  })

  return placed.map((anchor, index): RelationAnchorNode => {
    const otherAnchorPoints = placed
      .filter((_other, otherIndex) => otherIndex !== index)
      .map(renderedCenter)
    const clearance = anchorHitClearance(renderedCenter(anchor), otherAnchorPoints, portPoints)
    return {
      ...anchor,
      type: 'relationAnchor',
      width: 1,
      height: 1,
      style: {
        width: 1,
        height: 1,
        '--anchor-hit-clearance': `${clearance}px`
      } as CSSProperties,
      measured: { width: 1, height: 1 },
      handles: [
        {
          id: 'record',
          type: 'target',
          position: Position.Top,
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }
      ],
      draggable: false,
      selectable: false,
      focusable: false,
      deletable: false,
      zIndex: 6
    }
  })
}

const LABEL_HEIGHT = 32
const LABEL_LIFTS = [36, 62, 88, 114, 140]

function relationLabelLift(
  labelX: number,
  labelY: number,
  text: string,
  cards: readonly SessionCard[]
): number | null {
  const width = Math.min(288, 44 + text.length * 15)
  const left = labelX - width / 2 - 8
  const right = labelX + width / 2 + 8
  for (const lift of LABEL_LIFTS) {
    const top = labelY - lift - LABEL_HEIGHT / 2 - 8
    const bottom = labelY - lift + LABEL_HEIGHT / 2 + 8
    const overlaps = cards.some((card) => {
      const layout = card.layout
      return (
        left < layout.x + layout.width &&
        right > layout.x &&
        top < layout.y + layout.height &&
        bottom > layout.y
      )
    })
    if (!overlaps) return lift
  }
  return null
}

export function recordEdgesFromRelations(
  cards: readonly SessionCard[],
  relations: readonly SessionRelation[],
  anchors: readonly RelationAnchorNode[]
): RecordEdge[] {
  const cardsById = new Map(cards.map((card) => [card.cardId, card]))
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  return relations.flatMap((relation) => {
    if (!relation.recordCardId) return []
    const record = cardsById.get(relation.recordCardId)
    if (!record || (record.kind !== 'document' && record.kind !== 'prompt')) return []
    const anchor = anchorsById.get(relationAnchorId(relation.relationId))
    if (!anchor) return []
    const recordCenter = record.layout.x + record.layout.width / 2
    return [
      {
        id: `record-link:${relation.relationId}`,
        source: record.cardId,
        target: anchor.id,
        sourceHandle: recordCenter < anchor.position.x ? 'right' : 'left',
        targetHandle: 'record',
        type: 'recordLink',
        data: { relationId: relation.relationId },
        selectable: false,
        focusable: false,
        deletable: false,
        interactionWidth: 0,
        zIndex: 0
      }
    ]
  })
}
