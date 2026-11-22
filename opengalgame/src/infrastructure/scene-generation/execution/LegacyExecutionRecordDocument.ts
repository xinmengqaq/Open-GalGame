import { z } from 'zod'

import { assetCategoryOfPurpose } from '@domain/scenes/models/SceneAssetReference'


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

export const SCENE_GENERATION_EXECUTION_ENVELOPE_VERSIONS = [1, 2, 3, 4, 5, 6, 7] as const
export type SceneGenerationExecutionEnvelopeVersion =
  (typeof SCENE_GENERATION_EXECUTION_ENVELOPE_VERSIONS)[number]

export function isSupportedExecutionEnvelopeVersion(
  value: unknown
): value is SceneGenerationExecutionEnvelopeVersion {
  return (
    typeof value === 'number' &&
    (SCENE_GENERATION_EXECUTION_ENVELOPE_VERSIONS as readonly number[]).includes(value)
  )
}

const TERMINAL_OPERATION_STATES: Record<string, true> = {
  succeeded: true,
  failed: true,
  cancelled: true
}

/**
 * 旧记录的未结束状态需要旧版结算或作者明确保留，不能按“可归档”处理。
 * 这里与执行状态投影保持同一终态口径，但不依赖应用层展示模块。
 */
export function isUnfinishedLegacyOperationState(state: string): boolean {
  return TERMINAL_OPERATION_STATES[state] !== true
}

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

export function legacyExecutionRecordTimeFacts(value: unknown): LegacyExecutionRecordTimeFacts {
  if (!legacyRecord(value)) return { hasCreatedAt: false, hasUpdatedAt: false, hasTimeline: false }
  return {
    hasCreatedAt: typeof value.createdAt === 'string',
    hasUpdatedAt: typeof value.updatedAt === 'string',
    hasTimeline: Array.isArray(value.timeline) && value.timeline.length > 0
  }
}

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
