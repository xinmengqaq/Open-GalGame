import { z } from 'zod'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  executionDocumentSchema,
  SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION
} from './SceneGenerationExecutionDocument'
import {
  isSupportedExecutionEnvelopeVersion,
  isUnfinishedLegacyOperationState,
  legacyExecutionRecordReason,
  legacyExecutionRecordTimeFacts,
  legacyOperationFactSchema,
  migrateExecutionDocument,
  type LegacyExecutionRecordReason,
  type LegacyOperationFact
} from './LegacyExecutionRecordDocument'
import {
  executionRecordDocumentModifiedAt,
  executionRecordRelativePath,
  readExecutionRecordDocumentBytes,
  restoreExecutionRecordSource,
  sha256Hex,
  writeBytesAtomically,
  writeExecutionRecordArchive,
  type ExecutionArchiveLegacyRecord
} from './LegacyExecutionRecordArchive'
import { restorePhaseTwoReviewInteraction } from './ReviewInteractionUpgrade'

const failure = { code: ErrorCodes.internalError, msg: '场景生成执行记录读写失败' }
const migrationRefusedMessage = '执行记录迁移未完成，拒绝读取未迁移记录'

const envelopeSchema = z.object({
  version: z.number(),
  executions: z.array(z.unknown())
})

export interface LegacyExecutionRecord {
  readonly fact: LegacyOperationFact
  readonly raw: unknown
  readonly reason: LegacyExecutionRecordReason
}

/** 不能证明已结束的旧记录；用于在改写/归档前阻断整个文件。 */
export interface LegacyExecutionBlocker extends LegacyOperationFact {
  readonly reason: LegacyExecutionRecordReason
}

export interface ExecutionRecordMigrationPlan {
  readonly projectId: string
  readonly relativePath: string
  readonly sourceBytes: Buffer
  readonly sourceSha256: string
  readonly envelopeVersion: number
  readonly currentExecutions: readonly SceneGenerationExecution[]
  readonly legacyRecords: readonly LegacyExecutionRecord[]
  /** 未结束的旧记录；非空时整批阻断，不归档也不改写任何记录。 */
  readonly blockedRecords: readonly LegacyExecutionBlocker[]
  readonly blocked: boolean
  readonly targetDocument: { readonly version: number; readonly executions: readonly unknown[] }
  readonly targetBytes: Buffer
  readonly targetSha256: string
  readonly counts: {
    readonly total: number
    readonly current: number
    readonly legacy: number
  }
  readonly rewrite: boolean
}

export type ExecutionRecordMigrationOutcome = 'unchanged' | 'migrated' | 'blocked' | 'failed'

export interface ExecutionRecordMigrationRun {
  readonly plan: ExecutionRecordMigrationPlan
  readonly outcome: ExecutionRecordMigrationOutcome
  readonly archiveDirectory?: string
  readonly archiveReused?: boolean
  readonly error?: string
}

function migrationFailure(message?: string, cause?: unknown): AppException {
  return new AppException({
    ...failure,
    ...(message === undefined ? {} : { msg: message }),
    ...(cause === undefined ? {} : { cause })
  })
}

/**
 * 未结束旧记录不能按“已归档/已升级”处理：先让作者在旧版结算或明确保留草稿。
 * 文案只描述可执行路径，不承诺归档能继续，也不补造任何时间或授权事实。
 */
export function legacyMigrationBlockedMessage(
  records: readonly LegacyExecutionBlocker[]
): string {
  const summary = records.map((record) => `${record.operationId}（${record.state}）`).join('、')
  return `旧版生成记录仍有未结束操作：${summary}。已停止迁移：执行记录文件未改写，也未创建归档。请先用旧版打开该工程，完成或取消这些操作（或明确保留草稿），再重新迁移；归档只保留迁移前字节，不能用于继续生成。`
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  if (keys.length !== Object.keys(rightRecord).length) return false
  return keys.every(
    (key) => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key], rightRecord[key])
  )
}

type ClassifiedExecutionRecord =
  | { readonly execution: SceneGenerationExecution; readonly changed: boolean }
  | { readonly record: LegacyExecutionRecord }

function classifyExecutionRecord(projectId: string, item: unknown): ClassifiedExecutionRecord {
  const migrated = migrateExecutionDocument(item)
  const current = executionDocumentSchema.safeParse(migrated)
  if (current.success) {
    if (current.data.projectId !== projectId)
      throw migrationFailure('场景生成执行记录不属于当前工程')
    return { execution: current.data, changed: !jsonEqual(item, migrated) }
  }
  const legacy = legacyOperationFactSchema.safeParse(item)
  if (!legacy.success || legacy.data.projectId !== projectId)
    throw migrationFailure(undefined, legacy.success ? undefined : legacy.error)
  return {
    record: {
      fact: legacy.data,
      raw: item,
      reason: legacyExecutionRecordReason(item)
    }
  }
}

export function planExecutionRecordMigration(
  sourceBytes: Buffer,
  projectId: string
): ExecutionRecordMigrationPlan {
  const relativePath = executionRecordRelativePath(projectId)
  let value: unknown
  try {
    value = JSON.parse(sourceBytes.toString('utf8'))
  } catch (error) {
    throw migrationFailure(undefined, error)
  }
  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success) throw migrationFailure(undefined, envelope.error)
  if (!isSupportedExecutionEnvelopeVersion(envelope.data.version))
    throw migrationFailure('执行记录信封版本不受支持')

  const entries = envelope.data.executions.map((item) => {
    const classified = classifyExecutionRecord(projectId, item)
    if (!('execution' in classified)) return classified
    // 第二阶段只允许丢弃的等待恢复原有动作集；记录本身和已接受回复不改写。
    const upgraded = restorePhaseTwoReviewInteraction(classified.execution)
    return {
      execution: upgraded.execution,
      changed: classified.changed || upgraded.changed
    }
  })
  const currentExecutions = entries.flatMap((entry) =>
    'execution' in entry ? [entry.execution] : []
  )
  const legacyRecords = entries.flatMap((entry) => ('record' in entry ? [entry.record] : []))
  const blockedRecords = legacyRecords
    .filter((record) => isUnfinishedLegacyOperationState(record.fact.state))
    .map((record) => ({ ...record.fact, reason: record.reason }))
  const targetDocument = {
    version: SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION,
    executions: currentExecutions
  }
  const targetBytes = Buffer.from(`${JSON.stringify(targetDocument, null, 2)}\n`, 'utf8')
  const counts = {
    total: entries.length,
    current: currentExecutions.length,
    legacy: legacyRecords.length
  }
  const changed = entries.some((entry) => 'execution' in entry && entry.changed)
  return {
    projectId,
    relativePath,
    sourceBytes,
    sourceSha256: sha256Hex(sourceBytes),
    envelopeVersion: envelope.data.version,
    currentExecutions,
    legacyRecords,
    blockedRecords,
    blocked: blockedRecords.length > 0,
    targetDocument,
    targetBytes,
    targetSha256: sha256Hex(targetBytes),
    counts,
    rewrite:
      legacyRecords.length > 0 ||
      envelope.data.version !== SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION ||
      changed
  }
}

export function verifyExecutionRecordTarget(
  writtenBytes: Buffer,
  plan: ExecutionRecordMigrationPlan
): void {
  if (sha256Hex(writtenBytes) !== plan.targetSha256)
    throw migrationFailure('执行记录迁移后摘要不一致')
  let value: unknown
  try {
    value = JSON.parse(writtenBytes.toString('utf8'))
  } catch (error) {
    throw migrationFailure('执行记录迁移结果不是合法 JSON', error)
  }
  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success || envelope.data.version !== SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION)
    throw migrationFailure('执行记录迁移结果版本不符合当前格式')
  if (envelope.data.executions.length !== plan.currentExecutions.length)
    throw migrationFailure('执行记录迁移结果数量与当前记录不一致')

  const legacyOperationIds = new Set(plan.legacyRecords.map((record) => record.fact.operationId))
  for (let index = 0; index < envelope.data.executions.length; index += 1) {
    const expected = plan.currentExecutions[index]
    if (expected === undefined) throw migrationFailure('执行记录迁移结果顺序不一致')
    const parsed = executionDocumentSchema.safeParse(envelope.data.executions[index])
    if (!parsed.success) throw migrationFailure('执行记录迁移结果包含非当前记录', parsed.error)
    if (parsed.data.projectId !== plan.projectId)
      throw migrationFailure('执行记录迁移结果不属于当前工程')
    if (!jsonEqual(parsed.data, expected))
      throw migrationFailure('执行记录迁移结果与内存当前记录不一致')
    if (expected.createdAt !== undefined && parsed.data.createdAt !== expected.createdAt)
      throw migrationFailure('执行记录迁移结果丢失创建时间')
    if (expected.updatedAt !== undefined && parsed.data.updatedAt !== expected.updatedAt)
      throw migrationFailure('执行记录迁移结果丢失更新时间')
    if (expected.timeline !== undefined && !jsonEqual(parsed.data.timeline, expected.timeline))
      throw migrationFailure('执行记录迁移结果丢失时间线')
    if (legacyOperationIds.has(parsed.data.operationId))
      throw migrationFailure('执行记录迁移结果仍包含已归档旧记录')
  }
}

function archiveLegacyRecords(
  records: readonly LegacyExecutionRecord[]
): ExecutionArchiveLegacyRecord[] {
  return records.map((record) => {
    const timeFacts = legacyExecutionRecordTimeFacts(record.raw)
    return {
      projectId: record.fact.projectId,
      sceneId: record.fact.sceneId,
      operationId: record.fact.operationId,
      threadId: record.fact.threadId,
      branchId: record.fact.branchId,
      fingerprint: record.fact.fingerprint,
      state: record.fact.state,
      hasCreatedAt: timeFacts.hasCreatedAt,
      hasUpdatedAt: timeFacts.hasUpdatedAt,
      hasTimeline: timeFacts.hasTimeline,
      rawSha256: sha256Hex(Buffer.from(JSON.stringify(record.raw), 'utf8')),
      reason: record.reason
    }
  })
}

export async function migrateExecutionRecordFile(input: {
  readonly stateRoot: string
  readonly projectId: string
  readonly relativePath: string
  readonly documentPath: string
  readonly bytes: Buffer
}): Promise<ExecutionRecordMigrationRun> {
  const plan = planExecutionRecordMigration(input.bytes, input.projectId)
  if (plan.relativePath !== input.relativePath) throw migrationFailure('执行记录路径与工程不一致')
  if (plan.blocked)
    return { plan, outcome: 'blocked', error: legacyMigrationBlockedMessage(plan.blockedRecords) }
  if (!plan.rewrite) return { plan, outcome: 'unchanged' }

  const currentBytes = await readExecutionRecordDocumentBytes(input.documentPath)
  if (currentBytes === null || sha256Hex(currentBytes) !== plan.sourceSha256)
    throw migrationFailure('执行记录在迁移前发生变化')
  const modifiedAt = await executionRecordDocumentModifiedAt(input.documentPath)

  let archiveDirectory: string | undefined
  let archiveReused: boolean | undefined
  let targetWritten = false
  try {
    const archive = await writeExecutionRecordArchive({
      stateRoot: input.stateRoot,
      projectId: input.projectId,
      relativePath: plan.relativePath,
      sourceBytes: plan.sourceBytes,
      sourceSha256: plan.sourceSha256,
      envelopeVersion: plan.envelopeVersion,
      modifiedAt,
      targetSha256: plan.targetSha256,
      counts: plan.counts,
      legacyRecords: archiveLegacyRecords(plan.legacyRecords)
    })
    archiveDirectory = archive.directory
    archiveReused = archive.reused
    await writeBytesAtomically(input.documentPath, plan.targetBytes)
    targetWritten = true
    const writtenBytes = await readExecutionRecordDocumentBytes(input.documentPath)
    if (writtenBytes === null) throw migrationFailure('执行记录迁移结果无法读回')
    verifyExecutionRecordTarget(writtenBytes, plan)
    return {
      plan,
      outcome: 'migrated',
      archiveDirectory,
      archiveReused
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '执行记录归档或写回失败'
    if (archiveDirectory !== undefined && !targetWritten) {
      const diskBytes = await readExecutionRecordDocumentBytes(input.documentPath)
      if (diskBytes !== null) {
        const diskSha256 = sha256Hex(diskBytes)
        if (diskSha256 === plan.targetSha256) targetWritten = true
        else if (diskSha256 !== plan.sourceSha256)
          throw migrationFailure('执行记录迁移失败且磁盘状态未知')
      }
    }
    if (targetWritten && archiveDirectory !== undefined) {
      const restored = await restoreExecutionRecordSource({
        stateRoot: input.stateRoot,
        projectId: input.projectId,
        relativePath: plan.relativePath,
        archiveDirectory,
        writtenTargetSha256: plan.targetSha256
      })
      if (!restored) throw migrationFailure('执行记录迁移后校验失败，且记录已被外部改写')
    }
    return {
      plan,
      outcome: 'failed',
      ...(archiveDirectory === undefined ? {} : { archiveDirectory }),
      ...(archiveReused === undefined ? {} : { archiveReused }),
      error: message
    }
  }
}

export async function readCurrentExecutionRecordFile(input: {
  readonly stateRoot: string
  readonly projectId: string
  readonly relativePath: string
  readonly documentPath: string
}): Promise<readonly SceneGenerationExecution[]> {
  const bytes = await readExecutionRecordDocumentBytes(input.documentPath)
  if (bytes === null) return []
  const plan = planExecutionRecordMigration(bytes, input.projectId)
  if (plan.blocked)
    throw new AppException({
      ...failure,
      msg: legacyMigrationBlockedMessage(plan.blockedRecords)
    })
  if (!plan.rewrite) return plan.currentExecutions
  const run = await migrateExecutionRecordFile({
    stateRoot: input.stateRoot,
    projectId: input.projectId,
    relativePath: input.relativePath,
    documentPath: input.documentPath,
    bytes
  })
  if (run.outcome !== 'migrated')
    throw new AppException({
      ...failure,
      msg: migrationRefusedMessage,
      ...(run.error === undefined ? {} : { cause: run.error })
    })
  return plan.currentExecutions
}
