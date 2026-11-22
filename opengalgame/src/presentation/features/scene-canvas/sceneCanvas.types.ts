import type { Edge, Node } from '@xyflow/react'

import type { RelationLabelView } from '../workbench-session/workbenchSessionSelectors'
import type { SessionCardKind } from '../workbench-session/workbenchSession.types'

export type InputCardNode = Node<{ cardId: string }, 'inputCard'>

export type RelationAnchorData = {
  relationId: string
  label: string
  labelKind: RelationLabelView['kind']
  sourceKind: SessionCardKind
  recordCardId: string | null
  recordLabel: string | null
  recordKind: 'document' | 'prompt' | null
  rejected?: boolean
  condensed?: boolean
  labelLift?: number
}

export type RelationAnchorNode = Node<RelationAnchorData, 'relationAnchor'>

export type CanvasNode = InputCardNode | RelationAnchorNode

export type SessionEdgeData = {
  relationId: string
  pending: boolean
  active?: boolean
  rejected?: boolean
}

export type SessionEdge = Edge<SessionEdgeData, 'sessionAssociation'>

export type RecordEdge = Edge<{ relationId: string }, 'recordLink'>

export type CanvasEdge = SessionEdge | RecordEdge

export type CanvasMenuState = {
  x: number
  y: number
  cardId: string
  editLabel: string | null
} | null

export type CanvasNotice = {
  key: number
  text: string
  tone: 'error' | 'info'
}

export type CanvasClickPreview = {
  from: { x: number; y: number }
  to: { x: number; y: number }
}
