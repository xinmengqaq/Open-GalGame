import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasRelation
} from '../models/SceneCanvasArrangement'
import { relationPair, validateSceneCanvasArrangement } from './validateSceneCanvasArrangement'

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
        defaultRelation: 'associated',
        specificName: '',
        recordCardId: null
      }
    ]
  })
}

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
