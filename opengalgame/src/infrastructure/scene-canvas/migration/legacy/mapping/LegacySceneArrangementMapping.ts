import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasRelation
} from '@domain/scene-canvas/models/SceneCanvasArrangement'

import { copyUsage } from '@infrastructure/scene-canvas/sceneArrangementCurrentMapping'
import type { SceneCanvasArrangementV4Document } from '../documents/SceneCanvasArrangementV4Document'
import type {
  ProjectCanvasArrangement,
  ProjectCanvasCard
} from '../models/LegacyProjectCanvasArrangement'

/** 旧 v4 没有保存、由迁移映射按既有产品默认语义补齐的字段。 */
export type SceneArrangementDefaultedField = {
  object: 'card' | 'relation'
  objectId: string
  field: 'title' | 'summary' | 'usage' | 'defaultRelation'
}

export type SceneArrangementV4Read = {
  arrangement: SceneCanvasArrangement
  defaulted: readonly SceneArrangementDefaultedField[]
}

/**
 * 旧 v4 文档转当前模型。旧 v4 从未保存的字段按既有默认语义补齐，
 * 并在 defaulted 中逐项记录来源，不能把这些默认值当成旧 v4 已保存事实。
 * 仅供迁移工具与迁移测试使用，产品读取不再经过该函数。
 */
export function v4DocumentToCurrent(
  document: SceneCanvasArrangementV4Document
): SceneArrangementV4Read {
  const defaulted: SceneArrangementDefaultedField[] = []
  const cards: SceneCanvasCard[] = document.cards.map((card) => {
    if (card.kind === 'prompt') {
      defaulted.push(
        { object: 'card', objectId: card.cardId, field: 'title' },
        { object: 'card', objectId: card.cardId, field: 'summary' },
        { object: 'card', objectId: card.cardId, field: 'usage' }
      )
      return {
        kind: 'prompt',
        cardId: card.cardId,
        title: card.cardId,
        summary: '',
        body: card.body,
        references: (card.references ?? []).map((reference) => ({ cardId: reference.cardId })),
        usage: { targetIds: [] },
        layout: { ...card.layout }
      }
    }
    if (card.kind === 'animation' || card.kind === 'effect') {
      defaulted.push(
        { object: 'card', objectId: card.cardId, field: 'title' },
        { object: 'card', objectId: card.cardId, field: 'summary' },
        { object: 'card', objectId: card.cardId, field: 'usage' }
      )
      const base = {
        cardId: card.cardId,
        title: card.cardId,
        summary: '',
        webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
        usage: { targetIds: [] },
        layout: { ...card.layout }
      }
      return card.kind === 'animation'
        ? { ...base, kind: 'animation' as const }
        : { ...base, kind: 'effect' as const }
    }
    defaulted.push({ object: 'card', objectId: card.cardId, field: 'usage' })
    if (card.kind === 'image') {
      return { ...card, usage: { targetIds: [] }, layout: { ...card.layout } }
    }
    if (card.kind === 'audio') {
      return { ...card, usage: { targetIds: [] }, layout: { ...card.layout } }
    }
    if (card.kind === 'document') {
      return { ...card, usage: { targetIds: [] }, layout: { ...card.layout } }
    }
    return { ...card, usage: { targetIds: [] }, layout: { ...card.layout } }
  })
  const relations: SceneCanvasRelation[] = document.relations.map((relation) => {
    defaulted.push({
      object: 'relation',
      objectId: relation.relationId,
      field: 'defaultRelation'
    })
    return {
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      defaultRelation: 'associated',
      specificName: relation.specificName,
      recordCardId: relation.recordCardId
    }
  })
  return {
    arrangement: {
      projectId: document.projectId,
      sceneId: document.sceneId,
      canvasId: document.canvasId,
      viewport: { ...document.viewport },
      cards,
      relations
    },
    defaulted
  }
}

/**
 * 旧 v3 已由 legacy 读取/校验产生 ProjectCanvasArrangement。
 * 这里只把它逐项投影进唯一当前模型，不补默认值，也不改变旧 v3 校验语义。
 */
export function legacyProjectCanvasArrangementToCurrent(
  arrangement: ProjectCanvasArrangement
): SceneCanvasArrangement {
  return {
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map(copyLegacyCard),
    relations: arrangement.relations.map((relation) => ({
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      defaultRelation: relation.defaultRelation,
      specificName: relation.specificName,
      recordCardId: relation.recordCardId
    }))
  }
}

/**
 * 唯一当前模型投影为旧 v3 事实。仅供迁移工具复用旧校验与报错语义；
 * 当前格式读写不经过该函数，也不产生第二套当前模型。
 */
export function currentToLegacyCanvasArrangement(
  arrangement: SceneCanvasArrangement,
  version: string
): ProjectCanvasArrangement {
  return {
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    version,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map(currentCardToLegacy),
    relations: arrangement.relations.map((relation) => ({ ...relation }))
  }
}

function currentCardToLegacy(card: SceneCanvasCard): ProjectCanvasCard {
  if (card.kind === 'prompt') {
    return {
      kind: 'prompt',
      cardId: card.cardId,
      title: card.title,
      summary: card.summary,
      body: card.body,
      references: card.references.map((reference) => ({ cardId: reference.cardId })),
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
  if (card.kind === 'image') {
    return {
      kind: 'image',
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'audio') {
    return {
      kind: 'audio',
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'document') {
    return {
      kind: 'document',
      cardId: card.cardId,
      sourceId: card.sourceId,
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  return {
    kind: 'video',
    cardId: card.cardId,
    sourceId: card.sourceId,
    title: card.title,
    summary: card.summary,
    usage: copyUsage(card.usage),
    layout: { ...card.layout }
  }
}

function copyLegacyCard(card: ProjectCanvasCard): SceneCanvasCard {
  if (card.kind === 'prompt') {
    return {
      kind: 'prompt',
      cardId: card.cardId,
      title: card.title,
      summary: card.summary,
      body: card.body,
      references: card.references.map((reference) => ({ cardId: reference.cardId })),
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
  if (card.kind === 'image') {
    return {
      kind: 'image',
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'audio') {
    return {
      kind: 'audio',
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'document') {
    return {
      kind: 'document',
      cardId: card.cardId,
      sourceId: card.sourceId,
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage),
      layout: { ...card.layout }
    }
  }
  return {
    kind: 'video',
    cardId: card.cardId,
    sourceId: card.sourceId,
    title: card.title,
    summary: card.summary,
    usage: copyUsage(card.usage),
    layout: { ...card.layout }
  }
}
