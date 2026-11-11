import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '../errors/SceneCanvasErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasRelation
} from '../models/SceneCanvasArrangement'
import { relationPair, validateSceneCanvasArrangement } from './validateSceneCanvasArrangement'

/**
 * 连接两张卡片。反向连接视为同一条，不限制卡片类别。
 * @param relationId - 调用方生成的关联身份。
 * @throws {AppException} 自连、重复连线或端点不存在。
 */
export function connectSceneCanvasCards(
  arrangement: SceneCanvasArrangement,
  relationId: string,
  fromCardId: string,
  toCardId: string
): SceneCanvasArrangement {
  requireCard(arrangement, fromCardId)
  requireCard(arrangement, toCardId)
  if (fromCardId === toCardId) {
    throw new AppException({
      code: SceneCanvasErrorCodes.selfConnection,
      msg: '卡片不能连接自己'
    })
  }
  const pair = relationPair(fromCardId, toCardId)
  if (
    arrangement.relations.some(
      (relation) => relationPair(relation.fromCardId, relation.toCardId) === pair
    )
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.duplicateRelation,
      msg: '同一对卡片不能重复连接'
    })
  }
  const ends = fromCardId < toCardId ? [fromCardId, toCardId] : [toCardId, fromCardId]
  return commit({
    ...arrangement,
    relations: [
      ...arrangement.relations,
      {
        relationId,
        fromCardId: ends[0]!,
        toCardId: ends[1]!,
        specificName: '',
        recordCardId: null
      }
    ]
  })
}

/**
 * 删除一条关联，不删除两端卡片。
 * @throws {AppException} 关联不存在。
 */
export function disconnectSceneCanvasCards(
  arrangement: SceneCanvasArrangement,
  relationId: string
): SceneCanvasArrangement {
  requireRelation(arrangement, relationId)
  return commit({
    ...arrangement,
    relations: arrangement.relations.filter((relation) => relation.relationId !== relationId)
  })
}

/**
 * 写入特殊关系名称。清理首尾空白后可以为空。
 * @throws {AppException} 关联不存在。
 */
export function editSceneCanvasRelationName(
  arrangement: SceneCanvasArrangement,
  relationId: string,
  specificName: string
): SceneCanvasArrangement {
  const relation = requireRelation(arrangement, relationId)
  if (typeof specificName !== 'string') {
    throw new AppException({
      code: SceneCanvasErrorCodes.invalidField,
      msg: '特殊关系名称无效'
    })
  }
  return replaceRelation(arrangement, { ...relation, specificName: specificName.trim() })
}

/**
 * 装载或替换关系记录。记录卡可以同时是该关联的端点。
 * @throws {AppException} 记录类别不符或提示词记录已被占用。
 */
export function attachSceneCanvasRelationRecord(
  arrangement: SceneCanvasArrangement,
  relationId: string,
  recordCardId: string
): SceneCanvasArrangement {
  const relation = requireRelation(arrangement, relationId)
  const record = requireCard(arrangement, recordCardId)
  if (record.kind !== 'document' && record.kind !== 'prompt') {
    throw new AppException({
      code: SceneCanvasErrorCodes.invalidRecordKind,
      msg: '关系记录只能是文档卡或提示词卡'
    })
  }
  if (
    record.kind === 'prompt' &&
    arrangement.relations.some(
      (item) => item.relationId !== relationId && item.recordCardId === record.cardId
    )
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.promptRecordOccupied,
      msg: '同一张提示词卡只能装载到一条关联'
    })
  }
  return replaceRelation(arrangement, { ...relation, recordCardId })
}

/**
 * 卸下关系记录，保留关联和记录卡。
 * @throws {AppException} 关联不存在。
 */
export function detachSceneCanvasRelationRecord(
  arrangement: SceneCanvasArrangement,
  relationId: string
): SceneCanvasArrangement {
  const relation = requireRelation(arrangement, relationId)
  return replaceRelation(arrangement, { ...relation, recordCardId: null })
}

function replaceRelation(
  arrangement: SceneCanvasArrangement,
  relation: SceneCanvasRelation
): SceneCanvasArrangement {
  return commit({
    ...arrangement,
    relations: arrangement.relations.map((item) =>
      item.relationId === relation.relationId ? relation : item
    )
  })
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

function requireRelation(
  arrangement: SceneCanvasArrangement,
  relationId: string
): SceneCanvasRelation {
  const relation = arrangement.relations.find((item) => item.relationId === relationId)
  if (!relation) {
    throw new AppException({
      code: SceneCanvasErrorCodes.targetMissing,
      msg: '关联不存在'
    })
  }
  return relation
}

function commit(next: SceneCanvasArrangement): SceneCanvasArrangement {
  validateSceneCanvasArrangement(next)
  return next
}
