import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '../errors/SceneCanvasErrorCodes'
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

/**
 * 插入一张来源卡片。身份由调用方提供。
 * @throws {AppException} 身份冲突或字段无效。
 */
export function createSceneCanvasSourceCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasSourceCard
): SceneCanvasArrangement {
  return withCard(arrangement, normalizeSourceCard(card))
}

/**
 * 插入一张空正文也可保存的提示词卡片。
 * @throws {AppException} 身份冲突或布局无效。
 */
export function createSceneCanvasPromptCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasPromptCard
): SceneCanvasArrangement {
  return withCard(arrangement, {
    kind: 'prompt',
    cardId: card.cardId,
    body: card.body,
    references: card.references ?? [],
    layout: card.layout
  })
}

/**
 * 插入一张尚未绑定或已绑定字段的动画、特效卡片。
 * @throws {AppException} 身份冲突或绑定无效。
 */
export function createSceneCanvasFieldCard(
  arrangement: SceneCanvasArrangement,
  card: SceneCanvasFieldCard
): SceneCanvasArrangement {
  return withCard(arrangement, normalizeFieldCard(card))
}

/**
 * @throws {AppException} 目标缺失、字段不适用或标题为空。
 */
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

/**
 * 写入提示词正文。空正文可以保存。
 * @param body - 请求中的正文，不另作裁剪。
 * @throws {AppException} 目标不是提示词卡。
 */
export function editSceneCanvasPromptBody(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  body: string
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  if (card.kind !== 'prompt') throw fieldNotApplicable()
  return commit(replaceCard(arrangement, { ...card, body }))
}

/**
 * @param preset - 命令和名称；null 表示清空。
 * @throws {AppException} 目标不是字段卡，或绑定字段为空。
 */
export function bindSceneCanvasFieldPreset(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  preset: SceneCanvasWebgalPreset | null
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  if (card.kind !== 'animation' && card.kind !== 'effect') throw fieldNotApplicable()
  return commit(replaceCard(arrangement, normalizeFieldCard({ ...card, webgalPreset: preset })))
}

/**
 * 改图片或音频卡的场景用途。不改变来源和卡片类别。
 * @throws {AppException} 目标不是对应媒体卡，或用途不属于该类别。
 */
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

/**
 * 复制卡片内容和字段绑定，不复制关联。
 * @param newCardId - 调用方生成的新身份。
 * @throws {AppException} 源卡片不存在或新身份冲突。
 */
export function copySceneCanvasCard(
  arrangement: SceneCanvasArrangement,
  cardId: string,
  newCardId: string,
  layout: SceneCanvasCardLayout
): SceneCanvasArrangement {
  const card = requireCard(arrangement, cardId)
  return withCard(arrangement, { ...card, cardId: newCardId, layout })
}

/**
 * 删除卡片。以它为端点的关联删除，其余记录引用卸下。
 * @throws {AppException} 卡片不存在。
 */
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
