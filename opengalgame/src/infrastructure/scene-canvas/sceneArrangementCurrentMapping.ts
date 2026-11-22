import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasUsage
} from '@domain/scene-canvas/models/SceneCanvasArrangement'

import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  type SceneCanvasArrangementDocument
} from './documents/SceneCanvasArrangementDocument'

export function currentDocumentToModel(
  document: SceneCanvasArrangementDocument
): SceneCanvasArrangement {
  return {
    projectId: document.projectId,
    sceneId: document.sceneId,
    canvasId: document.canvasId,
    viewport: { ...document.viewport },
    cards: document.cards.map(copyDocumentCard),
    relations: document.relations.map((relation) => ({ ...relation }))
  }
}

export function modelToCurrentDocument(
  arrangement: SceneCanvasArrangement
): SceneCanvasArrangementDocument {
  return {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map(copyModelCard),
    relations: arrangement.relations.map((relation) => ({ ...relation }))
  }
}

function copyDocumentCard(card: SceneCanvasArrangementDocument['cards'][number]): SceneCanvasCard {
  if (card.kind === 'prompt') {
    return {
      ...card,
      references: (card.references ?? []).map((reference) => ({ cardId: reference.cardId })),
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'animation' || card.kind === 'effect') {
    const base = {
      cardId: card.cardId,
      title: card.title,
      summary: card.summary,
      webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
    return card.kind === 'animation'
      ? { ...base, kind: 'animation' as const }
      : { ...base, kind: 'effect' as const }
  }
  if (card.kind === 'image')
    return { ...card, usage: copyUsage(card.usage), layout: { ...card.layout } }
  if (card.kind === 'audio')
    return { ...card, usage: copyUsage(card.usage), layout: { ...card.layout } }
  if (card.kind === 'document') {
    return { ...card, usage: copyUsage(card.usage), layout: { ...card.layout } }
  }
  return { ...card, usage: copyUsage(card.usage), layout: { ...card.layout } }
}

function copyModelCard(card: SceneCanvasCard): SceneCanvasArrangementDocument['cards'][number] {
  if (card.kind === 'prompt') {
    return {
      ...card,
      references: card.references.map((reference) => ({ cardId: reference.cardId })),
      usage: copyDocumentUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'animation' || card.kind === 'effect') {
    const base = {
      cardId: card.cardId,
      title: card.title,
      summary: card.summary,
      webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
      usage: copyDocumentUsage(card.usage),
      layout: { ...card.layout }
    }
    return card.kind === 'animation'
      ? { ...base, kind: 'animation' as const }
      : { ...base, kind: 'effect' as const }
  }
  if (card.kind === 'image') {
    return { ...card, usage: copyDocumentUsage(card.usage), layout: { ...card.layout } }
  }
  if (card.kind === 'audio') {
    return { ...card, usage: copyDocumentUsage(card.usage), layout: { ...card.layout } }
  }
  if (card.kind === 'document') {
    return { ...card, usage: copyDocumentUsage(card.usage), layout: { ...card.layout } }
  }
  return { ...card, usage: copyDocumentUsage(card.usage), layout: { ...card.layout } }
}

function copyDocumentUsage(
  usage: SceneCanvasUsage
): SceneCanvasArrangementDocument['cards'][number]['usage'] {
  return {
    ...(usage.characterId === undefined ? {} : { characterId: usage.characterId }),
    ...(usage.locationId === undefined ? {} : { locationId: usage.locationId }),
    ...(usage.spokenLine === undefined ? {} : { spokenLine: usage.spokenLine }),
    targetIds: [...usage.targetIds]
  }
}

export function copyUsage(usage: SceneCanvasUsage): SceneCanvasUsage {
  return {
    ...(usage.characterId === undefined ? {} : { characterId: usage.characterId }),
    ...(usage.locationId === undefined ? {} : { locationId: usage.locationId }),
    ...(usage.spokenLine === undefined ? {} : { spokenLine: usage.spokenLine }),
    targetIds: [...usage.targetIds]
  }
}
