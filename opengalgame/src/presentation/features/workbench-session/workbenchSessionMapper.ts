import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type {
  SceneCanvasArrangementVO,
  SceneCanvasCardVO
} from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { defaultCardSize } from './contentKindLabel'
import type {
  SessionCard,
  SessionCardKind,
  SessionCardLayout,
  SessionRelation,
  SessionSnapshot,
  SessionSourceCard,
  SessionViewport
} from './workbenchSession.types'

export type DraftSource = {
  projectId: string
  sceneId: string
  canvasId: string
  cards: readonly SessionCard[]
  relations: readonly SessionRelation[]
  viewport: SessionViewport
}

export function draftArrangementOf(state: DraftSource): SceneCanvasArrangementVO {
  return {
    projectId: state.projectId,
    sceneId: state.sceneId,
    canvasId: state.canvasId,
    viewport: { ...state.viewport },
    cards: state.cards.map(cloneCard),
    relations: state.relations.map((relation) => ({ ...relation }))
  }
}

export function snapshotOf(
  state: Pick<DraftSource, 'cards' | 'relations' | 'viewport'>
): SessionSnapshot {
  return {
    cards: state.cards.map(cloneCard),
    relations: state.relations.map((relation) => ({ ...relation })),
    viewport: { ...state.viewport }
  }
}

export function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    cards: snapshot.cards.map(cloneCard),
    relations: snapshot.relations.map((relation) => ({ ...relation })),
    viewport: { ...snapshot.viewport }
  }
}

export function cloneCard(card: SessionCard): SessionCard {
  if (card.kind === 'animation' || card.kind === 'effect') {
    return {
      ...card,
      layout: { ...card.layout },
      webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset }
    }
  }
  if (card.kind === 'prompt') {
    return {
      ...card,
      layout: { ...card.layout },
      references: (card.references ?? []).map((reference) => ({ ...reference }))
    }
  }
  return { ...card, layout: { ...card.layout } }
}

export function draftFingerprint(
  cards: readonly SessionCard[],
  relations: readonly SessionRelation[],
  viewport: SessionViewport
): string {
  return JSON.stringify({
    cards: cards.map((card) => serializeCard(card)),
    relations: relations.map((relation) => [
      relation.relationId,
      relation.fromCardId,
      relation.toCardId,
      relation.specificName,
      relation.recordCardId
    ]),
    viewport: [viewport.x, viewport.y, viewport.zoom]
  })
}

export function snapshotFingerprint(snapshot: SessionSnapshot): string {
  return draftFingerprint(snapshot.cards, snapshot.relations, snapshot.viewport)
}

export function arrangementDraftOf(arrangement: SceneCanvasArrangementVO): SessionSnapshot {
  return {
    cards: arrangement.cards.map(cloneCard),
    relations: arrangement.relations.map((relation) => ({ ...relation })),
    viewport: { ...arrangement.viewport }
  }
}

export function layoutAt(kind: SessionCardKind, x: number, y: number): SessionCardLayout {
  const size = defaultCardSize(kind)
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height }
}

export function sourceCardKindOfSource(
  summary: ProjectInputSourceSummaryVO | undefined,
  detail: ProjectInputSourceVO | undefined
): SessionCardKind | null {
  const contentKind = summary?.contentKind ?? detail?.contentKind
  if (!contentKind) return null
  if (summary?.readable === false) return null
  return contentKind === 'text' ? 'document' : contentKind
}

export function sourceReadable(
  summary: ProjectInputSourceSummaryVO | undefined,
  detail: ProjectInputSourceVO | undefined
): boolean {
  if (summary) return summary.readable
  return detail !== undefined
}

export function retainSourceDetails(
  summaries: readonly ProjectInputSourceSummaryVO[],
  details: Readonly<Record<string, ProjectInputSourceVO>>
): Record<string, ProjectInputSourceVO> {
  const ids = new Set(summaries.map((item) => item.sourceId))
  const next: Record<string, ProjectInputSourceVO> = {}
  for (const [sourceId, detail] of Object.entries(details)) {
    if (ids.has(sourceId)) next[sourceId] = detail
  }
  return next
}

export function sourceNameOf(
  summary: ProjectInputSourceSummaryVO | undefined,
  detail: ProjectInputSourceVO | undefined
): string {
  if (detail) return detail.contentKind === 'text' ? detail.title : detail.name
  if (!summary) return '来源信息不可用'
  const summaryName = summary.name.trim()
  if (summaryName.length > 0) return summary.name
  return '来源信息不可用'
}

export function sourceDocumentFacts(
  card: SessionSourceCard,
  detail: ProjectInputSourceVO | undefined
): {
  topics: readonly string[]
  importFormat: 'markdown' | 'plainText' | null
  body: string | null
  description: string | null
} {
  if (card.kind === 'document' && detail?.contentKind === 'text') {
    return {
      topics: detail.topics,
      importFormat: detail.importInfo.format,
      body: detail.body,
      description: null
    }
  }
  return {
    topics: [],
    importFormat: null,
    body: null,
    description: detail && 'description' in detail ? detail.description : null
  }
}

export function layoutForNaturalPreview(
  layout: SessionCardLayout,
  naturalWidth: number,
  naturalHeight: number
): SessionCardLayout {
  const ratio = naturalHeight / naturalWidth
  const width = Math.min(360, Math.max(96, layout.width))
  return { ...layout, width, height: Math.max(96, Math.round(width * ratio)) }
}

export function normalizeCardTitle(title: string): string | null {
  const next = title.trim()
  return next.length > 0 ? next : null
}

function serializeCard(card: SessionCard): unknown {
  switch (card.kind) {
    case 'document':
      return [card.kind, card.cardId, card.sourceId, card.title, card.summary, layoutTuple(card)]
    case 'image':
      return [card.kind, card.cardId, card.sourceId, card.title, card.summary, layoutTuple(card)]
    case 'audio':
      return [card.kind, card.cardId, card.sourceId, card.title, card.summary, layoutTuple(card)]
    case 'video':
      return [card.kind, card.cardId, card.sourceId, card.title, card.summary, layoutTuple(card)]
    case 'prompt':
      return [
        card.kind,
        card.cardId,
        card.body,
        (card.references ?? []).map((reference) => reference.cardId),
        layoutTuple(card)
      ]
    case 'animation':
    case 'effect':
      return [
        card.kind,
        card.cardId,
        card.webgalPreset?.command ?? null,
        card.webgalPreset?.name ?? null,
        layoutTuple(card)
      ]
  }
}

function layoutTuple(card: SceneCanvasCardVO): [number, number, number, number] {
  return [card.layout.x, card.layout.y, card.layout.width, card.layout.height]
}
