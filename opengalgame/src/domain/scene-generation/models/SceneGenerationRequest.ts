import type { SceneAssetReference } from '../../scenes/models/SceneAssetReference'
import type { SceneIdentity } from '../../scenes/models/SceneIdentity'
import {
  SceneGenerationErrorCodes,
  type SceneGenerationErrorCode
} from '../errors/SceneGenerationErrorCodes'
import { AppException } from '@common/errors/AppException'

export type SceneLockState = 'locked' | 'unlocked' | 'unknown'

export type SceneBaselineState = 'unchanged' | 'changed' | 'unknown'

export type SceneControlKind = 'sceneJump' | 'option' | 'condition'

export interface SceneGenerationAsset extends SceneAssetReference {
  readonly sourceId: string
}

export interface SceneGenerationDocument {
  readonly id: string
  readonly sourceId: string
  readonly title: string
  readonly body: string
  readonly topics: readonly string[]
}

export type SceneGenerationPromptScope =
  | { readonly kind: 'scene' }
  | { readonly kind: 'cards'; readonly cardIds: readonly string[] }
  | { readonly kind: 'relation'; readonly relationId: string }

export interface SceneGenerationPrompt {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly scopes: readonly SceneGenerationPromptScope[]
}

export interface SceneGenerationFieldBinding {
  readonly cardId: string
  readonly kind: 'animation' | 'effect'
  readonly command: string | null
  readonly name: string | null
}

export type SceneGenerationDefaultRelation =
  'actsOn' | 'accompanies' | 'voices' | 'depicts' | 'constrains' | 'sameSubject' | 'associated'

export interface SceneGenerationRelation {
  readonly relationId: string
  readonly fromCardId: string
  readonly toCardId: string
  readonly defaultRelation: SceneGenerationDefaultRelation
  readonly specificName: string
  readonly record:
    | { readonly kind: 'document'; readonly cardId: string; readonly sourceId: string }
    | { readonly kind: 'prompt'; readonly cardId: string }
    | null
}

export interface ConfirmedSceneControl {
  readonly kind: SceneControlKind
  readonly content: string
  readonly inputId: string
}

export interface SceneGenerationRequest {
  readonly scene: SceneIdentity
  readonly assets: readonly SceneGenerationAsset[]
  readonly documents: readonly SceneGenerationDocument[]
  readonly prompts: readonly SceneGenerationPrompt[]
  readonly fieldBindings: readonly SceneGenerationFieldBinding[]
  readonly relations: readonly SceneGenerationRelation[]
  readonly maxCorrections: number
  readonly correctionsUsed: number
  readonly lockState: SceneLockState
  readonly baselineState: SceneBaselineState
  readonly confirmedControls: readonly ConfirmedSceneControl[]
}

/**
 * 拒绝身份、卡片输入或已确认控制不完整的生成请求。
 * 提示词以卡片身份和编排正文为准，不要求文件来源。
 * 已确认控制必须指向本次文档或提示词，不能只声明一个控制类别，也不能用关联代替。
 * @throws {AppException} 身份、来源、正文或已确认控制无法对应到本次输入。
 */
export function requireSceneGenerationRequest(request: SceneGenerationRequest): void {
  if (request.scene.projectId.trim() === '') {
    throw new AppException({
      code: SceneGenerationErrorCodes.blankProjectId,
      msg: '项目身份不能为空'
    })
  }
  if (request.scene.sceneId.trim() === '') {
    throw new AppException({
      code: SceneGenerationErrorCodes.blankSceneId,
      msg: '场景身份不能为空'
    })
  }
  requireDistinctIds(
    request.assets.map((asset) => asset.assetId),
    SceneGenerationErrorCodes.blankAssetId,
    '素材身份不能为空',
    SceneGenerationErrorCodes.duplicateAssetId,
    '同一次生成不能重复登记同一素材'
  )
  for (const asset of request.assets) requireSourceId(asset.sourceId)
  requireDistinctIds(
    request.documents.map((document) => document.id),
    SceneGenerationErrorCodes.blankDocumentId,
    '文档身份不能为空',
    SceneGenerationErrorCodes.duplicateDocumentId,
    '同一次生成不能重复登记同一文档'
  )
  for (const document of request.documents) {
    requireSourceId(document.sourceId)
    requireText(document.title, SceneGenerationErrorCodes.blankDocumentTitle, '文档标题不能为空')
    requireText(document.body, SceneGenerationErrorCodes.blankDocumentBody, '文档正文不能为空')
  }
  requireDistinctIds(
    request.prompts.map((prompt) => prompt.id),
    SceneGenerationErrorCodes.blankPromptId,
    '提示词身份不能为空',
    SceneGenerationErrorCodes.duplicatePromptId,
    '同一次生成不能重复登记同一提示词'
  )
  for (const prompt of request.prompts) {
    requireText(prompt.title, SceneGenerationErrorCodes.blankPromptBody, '提示词标题不能为空')
    requireText(prompt.body, SceneGenerationErrorCodes.blankPromptBody, '提示词正文不能为空')
    if (prompt.scopes.length === 0) {
      throw new AppException({
        code: SceneGenerationErrorCodes.blankPromptBody,
        msg: '提示词作用范围不能为空'
      })
    }
  }
  requireDistinctIds(
    request.fieldBindings.map((binding) => binding.cardId),
    SceneGenerationErrorCodes.blankAssetId,
    '字段卡片身份不能为空',
    SceneGenerationErrorCodes.duplicateAssetId,
    '同一次生成不能重复登记同一字段卡片'
  )
  const cardIds = new Set([
    ...request.assets.map((asset) => asset.assetId),
    ...request.documents.map((document) => document.id),
    ...request.prompts.map((prompt) => prompt.id),
    ...request.fieldBindings.map((binding) => binding.cardId)
  ])
  validateRelations(request.relations, request.documents, request.prompts, cardIds)
  const inputIds = new Set([
    ...request.documents.map((document) => document.id),
    ...request.prompts.map((prompt) => prompt.id)
  ])
  for (const control of request.confirmedControls) {
    if (control.content.trim() === '') {
      throw new AppException({
        code: SceneGenerationErrorCodes.blankConfirmedContent,
        msg: '已确认控制必须写明具体内容'
      })
    }
    if (!inputIds.has(control.inputId)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.unknownConfirmedInput,
        msg: '已确认控制必须指向本次文档或提示词'
      })
    }
  }
}

/**
 * @param blankCode - 空白身份的错误码。
 * @param blankMessage - 空白身份的说明。
 * @param duplicateCode - 重复身份的错误码。
 * @param duplicateMessage - 重复身份的说明。
 * @throws {AppException} 身份为空白或重复。
 */
function validateRelations(
  relations: readonly SceneGenerationRelation[],
  documents: readonly SceneGenerationDocument[],
  prompts: readonly SceneGenerationPrompt[],
  cardIds: ReadonlySet<string>
): void {
  const seen = new Set<string>()
  const pairs = new Set<string>()
  const promptRecords = new Set<string>()
  for (const relation of relations) {
    requireText(relation.relationId, SceneGenerationErrorCodes.blankAssetId, '关联身份不能为空')
    if (seen.has(relation.relationId)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.duplicateAssetId,
        msg: '同一次生成不能重复登记同一关联'
      })
    }
    seen.add(relation.relationId)
    if (
      relation.fromCardId === relation.toCardId ||
      !cardIds.has(relation.fromCardId) ||
      !cardIds.has(relation.toCardId)
    ) {
      throw new AppException({
        code: SceneGenerationErrorCodes.unknownConfirmedInput,
        msg: '关联两端必须是本次卡片'
      })
    }
    const pair = [relation.fromCardId, relation.toCardId].sort().join('\u0000')
    if (pairs.has(pair)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.duplicateAssetId,
        msg: '同一次生成不能重复登记同一对卡片的关联'
      })
    }
    pairs.add(pair)
    if (relation.record === null) continue
    if (relation.record.kind === 'document') {
      const document = documents.find((item) => item.id === relation.record?.cardId)
      if (!document || document.sourceId !== relation.record.sourceId) {
        throw new AppException({
          code: SceneGenerationErrorCodes.unknownConfirmedInput,
          msg: '关系记录必须指向本次文档'
        })
      }
      continue
    }
    if (
      !prompts.some((item) => item.id === relation.record?.cardId) ||
      promptRecords.has(relation.record.cardId)
    ) {
      throw new AppException({
        code: SceneGenerationErrorCodes.unknownConfirmedInput,
        msg: '关系记录必须指向本次提示词'
      })
    }
    promptRecords.add(relation.record.cardId)
  }
}

function requireDistinctIds(
  ids: readonly string[],
  blankCode: SceneGenerationErrorCode,
  blankMessage: string,
  duplicateCode: SceneGenerationErrorCode,
  duplicateMessage: string
): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (id.trim() === '') {
      throw new AppException({ code: blankCode, msg: blankMessage })
    }
    if (seen.has(id)) {
      throw new AppException({ code: duplicateCode, msg: duplicateMessage })
    }
    seen.add(id)
  }
}

/**
 * @throws {AppException} 来源标识为空白。
 */
function requireSourceId(sourceId: string): void {
  requireText(sourceId, SceneGenerationErrorCodes.blankSourceId, '来源标识不能为空')
}

/**
 * @param code - 空白时使用的错误码。
 * @param message - 空白时的说明。
 * @throws {AppException} 文本为空白。
 */
function requireText(value: string, code: SceneGenerationErrorCode, message: string): void {
  if (value.trim() === '') {
    throw new AppException({ code, msg: message })
  }
}
