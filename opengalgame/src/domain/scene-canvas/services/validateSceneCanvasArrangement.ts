import { AppException } from '@common/errors/AppException'
import { FailureReasons } from '@common/errors/FailureReasons'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasAudioRole,
  SceneCanvasCard,
  SceneCanvasDefaultRelation,
  SceneCanvasImageRole,
  SceneCanvasRelation,
  SceneCanvasUsage,
  SceneCanvasWebgalPreset
} from '../models/SceneCanvasArrangement'

export type SceneCanvasArrangementValidationOptions = {
  promptReferences?: boolean
}

export function validateSceneCanvasArrangement(
  arrangement: SceneCanvasArrangement,
  options: SceneCanvasArrangementValidationOptions = {}
): void {
  const checkPromptReferences = options.promptReferences !== false
  requireIdentity(arrangement.projectId, '工程身份不能为空')
  requireIdentity(arrangement.sceneId, '场景身份不能为空')
  requireIdentity(arrangement.canvasId, '画布身份不能为空')
  requireViewport(arrangement.viewport)
  if (!Array.isArray(arrangement.cards) || !Array.isArray(arrangement.relations)) {
    throw invalidField('画布卡片无效')
  }
  const cards = new Map<string, SceneCanvasCard>()
  for (const card of arrangement.cards) {
    validateCard(card, checkPromptReferences)
    if (cards.has(card.cardId)) {
      throw new AppException({
        code: SceneCanvasErrorCodes.identityConflict,
        msg: '同一编排不能重复登记同一卡片'
      })
    }
    cards.set(card.cardId, card)
  }
  if (checkPromptReferences) validatePromptReferences(cards)
  validateRelations(cards, arrangement.relations)
}

function validateCard(card: SceneCanvasCard, checkPromptReferenceIdentities: boolean): void {
  requireIdentity(card.cardId, '卡片身份不能为空')
  requireLayout(card.layout)
  requireTitle(card.title)
  requireText(card.summary, '卡片简介无效')
  validateUsage(card.usage)
  if (
    card.kind === 'document' ||
    card.kind === 'image' ||
    card.kind === 'audio' ||
    card.kind === 'video'
  ) {
    requireIdentity(card.sourceId, '卡片来源身份不能为空')
    if (card.kind === 'audio') requireAudioRole(card.role)
    if (card.kind === 'image') requireImageRole(card.role)
    return
  }
  if (card.kind === 'prompt') {
    requireText(card.body, '提示词正文无效')
    if (card.references === undefined) return
    if (!Array.isArray(card.references)) throw invalidField('提示词引用无效')
    for (const reference of card.references) {
      if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
        throw invalidField('提示词引用无效')
      }
      if (!checkPromptReferenceIdentities) continue
      requireIdentity(reference.cardId, '提示词引用身份不能为空')
    }
    return
  }
  if (card.kind === 'animation' || card.kind === 'effect') {
    requirePreset(card.webgalPreset)
    return
  }
  throw invalidField('卡片类别无效')
}

function validateRelations(
  cards: ReadonlyMap<string, SceneCanvasCard>,
  relations: readonly SceneCanvasRelation[]
): void {
  const seenRelations = new Set<string>()
  const seenPairs = new Set<string>()
  const promptRecords = new Set<string>()
  for (const relation of relations) {
    requireIdentity(relation.relationId, '关联身份不能为空')
    if (seenRelations.has(relation.relationId)) {
      throw new AppException({
        code: SceneCanvasErrorCodes.identityConflict,
        msg: '同一编排不能重复登记同一关联'
      })
    }
    seenRelations.add(relation.relationId)
    if (relation.fromCardId === relation.toCardId) {
      throw new AppException({
        code: SceneCanvasErrorCodes.selfConnection,
        msg: '卡片不能连接自己'
      })
    }
    const from = cards.get(relation.fromCardId)
    const to = cards.get(relation.toCardId)
    if (!from || !to) {
      throw new AppException({
        code: SceneCanvasErrorCodes.targetMissing,
        msg: '关联两端必须是当前编排中的卡片'
      })
    }
    const pair = relationPair(relation.fromCardId, relation.toCardId)
    if (seenPairs.has(pair)) {
      throw new AppException({
        code: SceneCanvasErrorCodes.duplicateRelation,
        msg: '同一对卡片不能重复连接'
      })
    }
    seenPairs.add(pair)
    requireDefaultRelation(relation.defaultRelation)
    requireText(relation.specificName, '特殊关系名称无效')
    if (relation.recordCardId === null) continue
    const record = cards.get(relation.recordCardId)
    if (!record) {
      throw new AppException({
        code: SceneCanvasErrorCodes.targetMissing,
        msg: '关系记录必须是当前编排中的卡片'
      })
    }
    if (record.kind !== 'document' && record.kind !== 'prompt') {
      throw new AppException({
        code: SceneCanvasErrorCodes.invalidRecordKind,
        msg: '关系记录只能是文档卡或提示词卡'
      })
    }
    if (record.kind === 'prompt') {
      if (promptRecords.has(record.cardId)) {
        throw new AppException({
          code: SceneCanvasErrorCodes.promptRecordOccupied,
          msg: '同一张提示词卡只能装载到一条关联'
        })
      }
      promptRecords.add(record.cardId)
    }
  }
}

function validatePromptReferences(cards: ReadonlyMap<string, SceneCanvasCard>): void {
  for (const card of cards.values()) {
    if (card.kind !== 'prompt' || card.references === undefined) continue
    const seen = new Set<string>()
    for (const reference of card.references) {
      if (seen.has(reference.cardId)) {
        throw new AppException({
          code: SceneCanvasErrorCodes.identityConflict,
          reason: FailureReasons.promptReferenceDuplicate,
          msg: '同一提示词不能重复引用同一卡片'
        })
      }
      seen.add(reference.cardId)
      const target = cards.get(reference.cardId)
      if (!target || target.cardId === card.cardId || target.kind === 'prompt') {
        throw new AppException({
          code: SceneCanvasErrorCodes.targetMissing,
          reason: FailureReasons.promptReferenceTargetMissing,
          msg: '提示词引用必须是当前画布中的其他卡片'
        })
      }
    }
  }
}

export function relationPair(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`
}

function requireViewport(viewport: SceneCanvasArrangement['viewport']): void {
  if (
    viewport === undefined ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom <= 0
  ) {
    throw invalidField('画布视口无效')
  }
}

function requireLayout(layout: SceneCanvasCard['layout']): void {
  if (
    layout === undefined ||
    !Number.isFinite(layout.x) ||
    !Number.isFinite(layout.y) ||
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.width <= 0 ||
    layout.height <= 0
  ) {
    throw invalidField('卡片布局无效')
  }
}

function requirePreset(preset: SceneCanvasWebgalPreset | null): void {
  if (preset === null) return
  if (typeof preset !== 'object') throw invalidField('字段绑定无效')
  requireTitle(preset.command)
  requireTitle(preset.name)
}

function validateUsage(usage: SceneCanvasUsage): void {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    throw invalidField('使用设置无效')
  }
  if (!Array.isArray(usage.targetIds)) throw invalidField('使用设置无效')
  requireOptionalText(usage.characterId)
  requireOptionalText(usage.locationId)
  requireOptionalText(usage.spokenLine)
  for (const targetId of usage.targetIds) {
    if (typeof targetId !== 'string' || targetId.trim() === '') throw invalidField('使用设置无效')
  }
}

function requireOptionalText(value: string | undefined): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw invalidField('使用设置无效')
  }
}

const defaultRelations: Record<SceneCanvasDefaultRelation, true> = {
  actsOn: true,
  accompanies: true,
  voices: true,
  depicts: true,
  constrains: true,
  sameSubject: true,
  associated: true
}

function requireDefaultRelation(relation: SceneCanvasDefaultRelation): void {
  if (!defaultRelations[relation]) throw invalidField('默认关系无效')
}

const imageRoles: Record<SceneCanvasImageRole, true> = {
  background: true,
  cg: true,
  characterImage: true,
  avatar: true
}
const audioRoles: Record<SceneCanvasAudioRole, true> = {
  music: true,
  soundEffect: true,
  voice: true
}

function requireImageRole(role: SceneCanvasImageRole): void {
  if (!imageRoles[role]) throw invalidField('图片用途无效')
}

function requireAudioRole(role: SceneCanvasAudioRole): void {
  if (!audioRoles[role]) throw invalidField('音频用途无效')
}

function requireTitle(value: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw invalidField('卡片标题不能为空')
}

function requireText(value: string, msg: string): void {
  if (typeof value !== 'string') throw invalidField(msg)
}

function requireIdentity(value: string, msg: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw invalidField(msg)
}

function invalidField(msg: string): AppException {
  return new AppException({ code: SceneCanvasErrorCodes.invalidField, msg })
}
