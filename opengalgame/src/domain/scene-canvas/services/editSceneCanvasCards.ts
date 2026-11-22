import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasAudioRole,
  SceneCanvasCard,
  SceneCanvasCardLayout,
  SceneCanvasFieldCard,
  SceneCanvasImageRole,
  SceneCanvasPromptCard,
  SceneCanvasSourceCard,
  SceneCanvasWebgalPreset
} from '../models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from './validateSceneCanvasArrangement'

export function createSceneCanvasSourceCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasSourceCard
): SceneCanvasArrangement {
  return withCard(arrangement, normalizeSourceCard(card))
}

export function createSceneCanvasPromptCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasPromptCard
): SceneCanvasArrangement {
  return withCard(arrangement, {
    kind: 'prompt',
    cardId: card.cardId,
    title: trimmedTitle(card.title),
    summary: card.summary,
    body: card.body,
    references: card.references ?? [],
    usage: card.usage,
    layout: card.layout
  })
}

export function createSceneCanvasFieldCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasFieldCard
): SceneCanvasArrangement {
  return withCard(arrangement, normalizeFieldCard(card))
}

export function editSceneCanvasCard(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  patch: { title?: string; summary?: string }
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  if (card.kind === 'prompt' || card.kind === 'animation' || card.kind === 'effect') {
    throw fieldNotApplicable()
  }
  if (
    patch.summary !== undefined &&
    card.kind !== 'document' &&
    card.kind !== 'image' &&
    card.kind !== 'audio' &&
    card.kind !== 'video'
  ) {
    throw fieldNotApplicable()
  }
  const next = replaceCard(arrangement, {
    ...card,
    ...(patch.title === undefined ? {} : { title: trimmedTitle(patch.title) }),
    ...(patch.summary === undefined ? {} : { summary: patch.summary })
  })
  return commit(next)
}

export function editSceneCanvasPromptBody(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  body: string
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  if (card.kind !== 'prompt') throw fieldNotApplicable()
  return commit(replaceCard(arrangement, { ...card, body }))
}

export function bindSceneCanvasFieldPreset(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  preset: SceneCanvasWebgalPreset | null
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  if (card.kind !== 'animation' && card.kind !== 'effect') throw fieldNotApplicable()
  return commit(replaceCard(arrangement, normalizeFieldCard({ ...card, webgalPreset: preset })))
}

export function editSceneCanvasMediaRole(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  role: SceneCanvasImageRole | SceneCanvasAudioRole
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  if (card.kind === 'image') {
    if (!isImageRole(role)) throw fieldNotApplicable()
    return commit(replaceCard(arrangement, { ...card, role }))
  }
  if (card.kind === 'audio') {
    if (!isAudioRole(role)) throw fieldNotApplicable()
    return commit(replaceCard(arrangement, { ...card, role }))
  }
  throw fieldNotApplicable()
}

export function copySceneCanvasCard(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  newCardId: string,
  layout: SceneCanvasCardLayout
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  return withCard(arrangement, { ...card, cardId: newCardId, layout })
}

export function deleteSceneCanvasCard(
  arrangement: SceneCanvasArrangement,
  cardId: string
): SceneCanvasArrangement {
  requireCard(arrangement, cardId)
  return commit({
    ...arrangement,
    cards: arrangement.cards
      .filter((card) => card.cardId !== cardId)
      .map((card) =>
        card.kind === 'prompt'
          ? {
              ...card,
              references: (card.references ?? []).filter((reference) => reference.cardId !== cardId)
            }
          : card
      ),
    relations: arrangement.relations
      .filter((relation) => relation.fromCardId !== cardId && relation.toCardId !== cardId)
      .map((relation) =>
        relation.recordCardId === cardId ? { ...relation, recordCardId: null } : relation
      )
  })
}

function withCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasCard
): SceneCanvasArrangement {
  return commit({ ...arrangement, cards: [...arrangement.cards, card] })
}

function replaceCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasCard
): SceneCanvasArrangement {
  return {
    ...arrangement,
    cards: arrangement.cards.map((item) => (item.cardId === card.cardId ? card : item))
  }
}

function normalizeSourceCard(card: SceneCanvasSourceCard): SceneCanvasSourceCard {
  if (card.kind === 'document' || card.kind === 'audio') {
    return { ...card, title: trimmedTitle(card.title) }
  }
  return { ...card, title: trimmedTitle(card.title) }
}

function normalizeFieldCard(card: SceneCanvasFieldCard): SceneCanvasFieldCard {
  if (card.webgalPreset === null) return { ...card, webgalPreset: null }
  return {
    ...card,
    webgalPreset: {
      command: trimmedTitle(card.webgalPreset.command),
      name: trimmedTitle(card.webgalPreset.name)
    }
  }
}

function requireCard(arrangement: SceneCanvasArrangement, cardId: string): SceneCanvasCard {
  const card = arrangement.cards.find((item) => item.cardId === cardId)
  if (!card) {
    throw new AppException({
      code: SceneCanvasErrorCodes.targetMissing,
      msg: '卡片不存在'
    })
  }
  return card
}

function trimmedTitle(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppException({
      code: SceneCanvasErrorCodes.invalidField,
      msg: '卡片标题不能为空'
    })
  }
  return value.trim()
}

function fieldNotApplicable(): AppException {
  return new AppException({
    code: SceneCanvasErrorCodes.fieldNotApplicable,
    msg: '该字段不适用于这张卡片'
  })
}

const imageRoleSet: Record<SceneCanvasImageRole, true> = {
  background: true,
  cg: true,
  characterImage: true,
  avatar: true
}
const audioRoleSet: Record<SceneCanvasAudioRole, true> = {
  music: true,
  soundEffect: true,
  voice: true
}

function isImageRole(
  role: SceneCanvasImageRole | SceneCanvasAudioRole
): role is SceneCanvasImageRole {
  return role in imageRoleSet
}

function isAudioRole(
  role: SceneCanvasImageRole | SceneCanvasAudioRole
): role is SceneCanvasAudioRole {
  return role in audioRoleSet
}

function commit(next: SceneCanvasArrangement): SceneCanvasArrangement {
  validateSceneCanvasArrangement(next)
  return next
}
