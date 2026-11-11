import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import { sourceNameOf } from './workbenchSessionMapper'
import type {
  SessionCard,
  SessionDocumentCard,
  SessionRelation,
  WorkbenchSessionState
} from './workbenchSession.types'

export function documentLayerCardOf(state: WorkbenchSessionState): SessionDocumentCard | null {
  if (!state.documentLayerCardId) return null
  const card = state.cards.find((item) => item.cardId === state.documentLayerCardId)
  return card?.kind === 'document' ? card : null
}

export type SourceFactsView = {
  summary: ProjectInputSourceSummaryVO | undefined
  detail: ProjectInputSourceVO | undefined
  name: string
  readable: boolean
  disconnected: boolean
}

/** 卡片上的来源状态只由来源目录与详情决定，不复制进编排。 */
export function sourceFactsOf(
  state: Pick<WorkbenchSessionState, 'sources' | 'sourceDetails'>,
  sourceId: string
): SourceFactsView {
  const summary = state.sources.find((item) => item.sourceId === sourceId)
  const detail = state.sourceDetails[sourceId]
  return {
    summary,
    detail,
    name: sourceNameOf(summary, detail),
    readable: summary ? summary.readable : detail !== undefined,
    disconnected: summary === undefined && detail === undefined
  }
}

export type RelationLabelView = {
  text: string
  kind: 'name' | 'documentRecord' | 'promptRecord' | 'empty'
}

/** 线上标签：特殊关系名优先，其次文档记录标题，再次提示词记录，最后“关系还没写”。 */
export function relationLabelOf(
  state: { cards: readonly SessionCard[] },
  relation: SessionRelation
): RelationLabelView {
  const name = relation.specificName.trim()
  if (name.length > 0) return { text: name, kind: 'name' }
  if (relation.recordCardId) {
    const record = state.cards.find((card) => card.cardId === relation.recordCardId)
    if (record?.kind === 'document') return { text: record.title, kind: 'documentRecord' }
    if (record?.kind === 'prompt') return { text: '提示词记录', kind: 'promptRecord' }
  }
  return { text: '关系还没写', kind: 'empty' }
}

/** 关联的记录卡（文档或提示词）。 */
export function relationRecordCardOf(
  state: { cards: readonly SessionCard[] },
  relation: SessionRelation
) {
  if (!relation.recordCardId) return null
  const card = state.cards.find((item) => item.cardId === relation.recordCardId)
  if (!card) return null
  return card.kind === 'document' || card.kind === 'prompt' ? card : null
}
