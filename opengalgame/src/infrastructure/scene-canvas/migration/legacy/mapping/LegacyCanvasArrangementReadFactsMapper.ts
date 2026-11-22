import { copyUsage } from '@infrastructure/scene-canvas/sceneArrangementCurrentMapping'
import type { SceneCanvasArrangementDocument } from '../documents/LegacySceneCanvasArrangementDocument'
import type { ProjectCanvasArrangement } from '../models/LegacyProjectCanvasArrangement'

export function toCanvasArrangement(
  document: SceneCanvasArrangementDocument,
  version: string
): ProjectCanvasArrangement {
  return {
    projectId: document.projectId,
    sceneId: document.sceneId,
    canvasId: document.canvasId,
    version,
    viewport: { ...document.viewport },
    cards: document.cards.map((card) => {
      const shared = {
        cardId: card.cardId,
        title: card.title,
        summary: card.summary,
        usage: copyUsage(card.usage),
        layout: { ...card.layout }
      }
      if (card.kind === 'prompt') {
        return {
          ...shared,
          kind: 'prompt' as const,
          body: card.body,
          references: (card.references ?? []).map((reference) => ({ cardId: reference.cardId }))
        }
      }
      if (card.kind === 'animation' || card.kind === 'effect') {
        return {
          ...shared,
          kind: card.kind,
          webgalPreset:
            card.webgalPreset === null
              ? null
              : { command: card.webgalPreset.command, name: card.webgalPreset.name }
        }
      }
      if (card.kind === 'document' || card.kind === 'video') {
        return { ...shared, kind: card.kind, sourceId: card.sourceId }
      }
      if (card.kind === 'image') {
        return { ...shared, kind: 'image' as const, sourceId: card.sourceId, role: card.role }
      }
      return { ...shared, kind: 'audio' as const, sourceId: card.sourceId, role: card.role }
    }),
    relations: document.relations.map((relation) => ({
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      defaultRelation: relation.defaultRelation,
      specificName: relation.specificName,
      recordCardId: relation.recordCardId
    }))
  }
}
