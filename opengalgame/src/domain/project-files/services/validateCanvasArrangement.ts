import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import type {
  ProjectCanvasArrangement,
  ProjectCanvasCard,
  ProjectCanvasRelation,
  ProjectCanvasUsageSettings,
  ProjectCanvasWebgalPreset
} from '../models/ProjectCanvasArrangement'

/**
 * 校验已读取的画布编排身份、卡片、关联和布局。
 * 不按卡片类型推断默认关系，也不解释坐标的剧情含义。
 * @throws {AppException} 身份不完整、卡片或关联重复、来源为空、字段绑定无效、布局或使用设置不能保存。
 */
export function validateCanvasArrangement(arrangement: ProjectCanvasArrangement): void {
  requireIdentity(arrangement.projectId, '工程身份不能为空')
  requireIdentity(arrangement.sceneId, '场景身份不能为空')
  requireIdentity(arrangement.canvasId, '画布身份不能为空')
  requireIdentity(arrangement.version, '编排版本不能为空')
  validateViewport(arrangement.viewport)
  if (!Array.isArray(arrangement.cards) || !Array.isArray(arrangement.relations)) {
    throw new AppException({
      code: ProjectFileErrorCodes.blankArrangementIdentity,
      msg: '画布卡片无效'
    })
  }
  const seen = new Set<string>()
  for (const card of arrangement.cards) validateCard(card, seen)
  validateRelations(arrangement.cards, arrangement.relations)
}

function validateCard(card: ProjectCanvasCard, seen: Set<string>): void {
  requireIdentity(card.cardId, '卡片身份不能为空')
  if (seen.has(card.cardId)) {
    throw new AppException({
      code: ProjectFileErrorCodes.duplicateCardId,
      msg: '同一编排不能重复登记同一卡片'
    })
  }
  seen.add(card.cardId)
  requireIdentity(card.title, '卡片标题不能为空')
  if (typeof card.summary !== 'string') throw invalidCardBinding()
  if (
    card.kind === 'document' ||
    card.kind === 'image' ||
    card.kind === 'audio' ||
    card.kind === 'video'
  ) {
    if (typeof card.sourceId !== 'string' || card.sourceId.trim() === '') {
      throw new AppException({
        code: ProjectFileErrorCodes.blankCardSourceId,
        msg: '卡片来源身份不能为空'
      })
    }
  } else if (card.kind === 'prompt') {
    if (typeof card.body !== 'string') throw invalidCardBinding()
  } else if (card.kind === 'animation' || card.kind === 'effect') {
    validateWebgalPreset(card.webgalPreset)
  } else {
    throw invalidCardBinding()
  }
  validateLayout(card.layout)
  validateUsage(card.usage)
}

function validateViewport(viewport: ProjectCanvasArrangement['viewport']): void {
  if (
    viewport === undefined ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom <= 0
  ) {
    throw new AppException({
      code: ProjectFileErrorCodes.invalidCardLayout,
      msg: '画布视口无效'
    })
  }
}

function validateRelations(
  cards: readonly ProjectCanvasCard[],
  relations: readonly ProjectCanvasRelation[]
): void {
  const cardsById = new Map(cards.map((card) => [card.cardId, card]))
  const seenRelations = new Set<string>()
  const seenPairs = new Set<string>()
  const promptRecords = new Set<string>()
  for (const relation of relations) {
    requireIdentity(relation.relationId, '关联身份不能为空')
    if (seenRelations.has(relation.relationId)) throw invalidRelation()
    seenRelations.add(relation.relationId)
    if (relation.fromCardId === relation.toCardId) throw invalidRelation()
    const from = cardsById.get(relation.fromCardId)
    const to = cardsById.get(relation.toCardId)
    if (!from || !to) throw invalidRelation()
    const pair = [relation.fromCardId, relation.toCardId].sort().join('\u0000')
    if (seenPairs.has(pair)) throw invalidRelation()
    seenPairs.add(pair)
    if (typeof relation.specificName !== 'string') throw invalidRelation()
    if (!isDefaultRelation(relation.defaultRelation)) throw invalidRelation()
    if (relation.recordCardId === null) continue
    const record = cardsById.get(relation.recordCardId)
    if (!record || (record.kind !== 'document' && record.kind !== 'prompt')) throw invalidRelation()
    if (record.kind === 'prompt') {
      if (promptRecords.has(record.cardId)) throw invalidRelation()
      promptRecords.add(record.cardId)
    }
  }
}

function isDefaultRelation(value: ProjectCanvasRelation['defaultRelation']): boolean {
  return (
    value === 'actsOn' ||
    value === 'accompanies' ||
    value === 'voices' ||
    value === 'depicts' ||
    value === 'constrains' ||
    value === 'sameSubject' ||
    value === 'associated'
  )
}

function invalidRelation(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.invalidCardBinding,
    msg: '卡片关联无效'
  })
}

function validateWebgalPreset(preset: ProjectCanvasWebgalPreset | null): void {
  if (preset === null) return
  if (
    typeof preset !== 'object' ||
    typeof preset.command !== 'string' ||
    preset.command.trim() === '' ||
    typeof preset.name !== 'string' ||
    preset.name.trim() === ''
  ) {
    throw invalidCardBinding()
  }
}

function validateLayout(layout: ProjectCanvasCard['layout']): void {
  if (
    layout === undefined ||
    !Number.isFinite(layout.x) ||
    !Number.isFinite(layout.y) ||
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.width <= 0 ||
    layout.height <= 0
  ) {
    throw new AppException({
      code: ProjectFileErrorCodes.invalidCardLayout,
      msg: '卡片布局无效'
    })
  }
}

function validateUsage(usage: ProjectCanvasUsageSettings): void {
  if (usage === undefined || !Array.isArray(usage.targetIds)) {
    throw invalidUsage()
  }
  requireOptionalText(usage.characterId)
  requireOptionalText(usage.locationId)
  requireOptionalText(usage.spokenLine)
  for (const targetId of usage.targetIds) {
    if (typeof targetId !== 'string' || targetId.trim() === '') throw invalidUsage()
  }
}

function requireOptionalText(value: string | undefined): void {
  if (value !== undefined && value.trim() === '') throw invalidUsage()
}

function invalidUsage(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.invalidUsageSettings,
    msg: '使用设置无效'
  })
}

function invalidCardBinding(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.invalidCardBinding,
    msg: '卡片字段绑定无效'
  })
}

function requireIdentity(value: string, msg: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankArrangementIdentity,
      msg
    })
  }
}
