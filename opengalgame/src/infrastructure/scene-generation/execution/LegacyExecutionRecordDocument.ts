import { z } from 'zod'

import { assetCategoryOfPurpose } from '@domain/scenes/models/SceneAssetReference'

/**
 * 旧执行记录的读取契约只服务迁移与恢复工具：产品仓库只读当前 v7，旧信封版本、
 * 旧分类/用途和 raw 事实都在这里识别，不能作为正常读取的回退入口。
 */

const text = z.string().min(1)
const operationState = z.enum([
  'pending',
  'running',
  'waiting',
  'committing',
  'interrupted',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled'
])

/** 旧输入快照仍要保留的操作身份。不补当前输入字段。 */
export const legacyOperationFactSchema = z.object({
  projectId: text,
  sceneId: text,
  operationId: text,
  threadId: text,
  branchId: text,
  fingerprint: text,
  state: operationState
})
export type LegacyOperationFact = z.infer<typeof legacyOperationFactSchema>

/** 执行记录信封版本；迁移只接受这些版本，当前产品只写最新版本。 */
export const SCENE_GENERATION_EXECUTION_ENVELOPE_VERSIONS = [1, 2, 3, 4, 5, 6, 7] as const
export type SceneGenerationExecutionEnvelopeVersion =
  (typeof SCENE_GENERATION_EXECUTION_ENVELOPE_VERSIONS)[number]

/** 只接受已知信封版本，不把更高版本当成可迁移旧格式。 */
export function isSupportedExecutionEnvelopeVersion(
  value: unknown
): value is SceneGenerationExecutionEnvelopeVersion {
  return (
    typeof value === 'number' &&
    (SCENE_GENERATION_EXECUTION_ENVELOPE_VERSIONS as readonly number[]).includes(value)
  )
}

/** 不能按当前格式读取的旧记录只能归档；归档原因不用于推断当前业务字段。 */
export const LEGACY_EXECUTION_RECORD_REASONS = [
  'missing-record-time',
  'current-schema-incomplete',
  'unsupported-envelope-version',
  'unreadable-record'
] as const
export type LegacyExecutionRecordReason = (typeof LEGACY_EXECUTION_RECORD_REASONS)[number]

export interface LegacyExecutionRecordTimeFacts {
  readonly hasCreatedAt: boolean
  readonly hasUpdatedAt: boolean
  readonly hasTimeline: boolean
}

/** 只读旧记录已有的时间事实，不用当前时间补齐。 */
export function legacyExecutionRecordTimeFacts(value: unknown): LegacyExecutionRecordTimeFacts {
  if (!legacyRecord(value)) return { hasCreatedAt: false, hasUpdatedAt: false, hasTimeline: false }
  return {
    hasCreatedAt: typeof value.createdAt === 'string',
    hasUpdatedAt: typeof value.updatedAt === 'string',
    hasTimeline: Array.isArray(value.timeline) && value.timeline.length > 0
  }
}

/**
 * 旧记录不能当前化时只记录阻塞原因：缺时间事实与 schema 不完整分开，
 * 避免把当前字段默认值冒充成旧记录已有事实。
 */
export function legacyExecutionRecordReason(value: unknown): LegacyExecutionRecordReason {
  const facts = legacyExecutionRecordTimeFacts(value)
  return facts.hasCreatedAt || facts.hasUpdatedAt || facts.hasTimeline
    ? 'current-schema-incomplete'
    : 'missing-record-time'
}

const legacyAssetPurpose = z.enum([
  'background',
  'cg',
  'characterImage',
  'avatar',
  'music',
  'soundEffect',
  'voice',
  'video'
])

/**
 * 把旧输入快照换算成当前字段：用途换算类别、清除旧引用角色。
 * 旧用途不合法时保持当前 schema 无法解析，继续按旧记录归档，不补造类别。
 */
export function migrateExecutionDocument(value: unknown): unknown {
  if (!legacyRecord(value)) return value
  const { phase: legacyPhase, ...record } = value
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : undefined
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : createdAt
  const timeline = Array.isArray(record.timeline) ? record.timeline : []
  const step = typeof record.step === 'string' ? record.step : migratedStep(legacyPhase)
  const migratedTimeline =
    timeline.length > 0 || updatedAt === undefined
      ? record.timeline
      : [
          {
            entryId: `${String(record.operationId)}:migrated`,
            sequence: typeof record.sequence === 'number' ? record.sequence : 0,
            createdAt: updatedAt,
            kind: record.failure || record.interruptReason ? 'failure' : 'stage',
            stage: migratedStage(record.state),
            message: '已恢复此前保存的生成记录'
          }
        ]
  return {
    ...record,
    ...(step === undefined ? {} : { step }),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(migratedTimeline === undefined ? {} : { timeline: migratedTimeline }),
    ...migratedInputSnapshot(record.inputSnapshot)
  }
}

function migratedInputSnapshot(value: unknown): { inputSnapshot?: unknown } {
  if (!legacyRecord(value)) return {}
  const assets = Array.isArray(value.assets) ? value.assets.map(migratedAsset) : undefined
  const prompts = Array.isArray(value.prompts) ? value.prompts.map(migratedPrompt) : undefined
  if (assets === undefined && prompts === undefined) return {}
  return {
    inputSnapshot: {
      ...value,
      ...(assets === undefined ? {} : { assets }),
      ...(prompts === undefined ? {} : { prompts })
    }
  }
}

function migratedAsset(value: unknown): unknown {
  if (!legacyRecord(value)) return value
  const { purpose, ...asset } = value
  if (purpose === undefined) return value
  const parsed = legacyAssetPurpose.safeParse(purpose)
  if (!parsed.success) return { ...asset, category: undefined }
  return {
    ...asset,
    category: asset.category ?? assetCategoryOfPurpose(parsed.data)
  }
}

function migratedPrompt(value: unknown): unknown {
  if (!legacyRecord(value) || !Array.isArray(value.references)) return value
  return {
    ...value,
    references: value.references.map(migratedReference)
  }
}

function migratedReference(value: unknown): unknown {
  if (!legacyRecord(value) || !Object.hasOwn(value, 'role')) return value
  const reference = { ...value }
  delete reference.role
  return reference
}

/** 旧记录的 phase 只用于迁移：业务步骤一一对应，终态或等待阶段不携带业务 step。 */
function migratedStep(phase: unknown): string | undefined {
  if (typeof phase !== 'string') return undefined
  if (phase === 'waiting' || phase === 'completed' || phase === 'failed' || phase === 'cancelled')
    return undefined
  return phase === 'preparing' ||
    phase === 'generating' ||
    phase === 'reading' ||
    phase === 'validating' ||
    phase === 'correcting' ||
    phase === 'converting' ||
    phase === 'committing' ||
    phase === 'rollingBack'
    ? phase
    : undefined
}

function migratedStage(state: unknown): string {
  if (state === 'succeeded') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'cancelled'
  if (state === 'interrupted') return 'paused'
  if (state === 'waiting') return 'waitingReview'
  if (state === 'committing') return 'committing'
  return 'generating'
}

function legacyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
