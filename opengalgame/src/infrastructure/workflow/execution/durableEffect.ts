import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { readJsonDocument, writeJsonDocument } from '@infrastructure/storage/jsonDocument'

import { assertRevisionToken } from '../CheckpointReference'
import type {
  DurableEffectKind,
  DurableEffectQuestion,
  DurableEffectRecord,
  DurableEffectStatus
} from '../DurableEffectRecord'
import { WorkflowError } from '../WorkflowError'
import { assertWorkflowSegment, type WorkflowIdentity } from '../WorkflowIdentity'
import {
  ensureStateRoot,
  resolveStatePath,
  workflowStorageFailure
} from '../checkpoints/checkpointPath'

export type EffectVerification =
  | { outcome: 'confirmed'; resultDigest: string; candidateRevision?: string }
  | { outcome: 'absent' }
  | { outcome: 'unknown' }

export type EffectRecovery =
  | { action: 'skip'; resultDigest: string; candidateRevision?: string }
  | { action: 'execute' }
  | { action: 'stop'; reason: string }

export function decideDurableEffectRecovery(
  record: DurableEffectRecord,
  verify: () => EffectVerification
): EffectRecovery {
  assertEffectRecord(record)
  if (isReliable(record)) {
    return {
      action: 'skip',
      resultDigest: record.resultDigest!,
      ...(record.candidateRevision !== undefined
        ? { candidateRevision: record.candidateRevision }
        : {})
    }
  }
  const actual = verify()
  if (actual.outcome === 'unknown') {
    return { action: 'stop', reason: '副作用结果不明，已停止恢复' }
  }
  if (actual.outcome === 'confirmed') {
    return {
      action: 'skip',
      resultDigest: actual.resultDigest,
      ...(actual.candidateRevision !== undefined
        ? { candidateRevision: actual.candidateRevision }
        : {})
    }
  }
  if (record.status === 'unknown') {
    return { action: 'stop', reason: '副作用结果不明，已停止恢复' }
  }
  return { action: 'execute' }
}

export async function writeDurableEffect(
  stateRoot: string,
  identity: WorkflowIdentity,
  record: DurableEffectRecord
): Promise<void> {
  assertEffectRecord(record)
  if (record.operationId !== identity.operationId) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '副作用记录超出当前操作' })
  }
  const root = await ensureStateRoot(stateRoot)
  const path = await resolveStatePath(
    root,
    `projects/${identity.projectId}/threads/${identity.threadId}/operations/${identity.operationId}/effects/${record.stepId}.json`
  )
  await writeJsonDocument(path, record, workflowStorageFailure)
}

export async function readDurableEffects(
  stateRoot: string,
  identity: WorkflowIdentity
): Promise<DurableEffectRecord[]> {
  const root = await ensureStateRoot(stateRoot)
  const directory = await resolveStatePath(
    root,
    `projects/${identity.projectId}/threads/${identity.threadId}/operations/${identity.operationId}/effects`
  )
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: DurableEffectRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const value = await readJsonDocument(join(directory, name), workflowStorageFailure)
    records.push(assertEffectRecord(asEffectRecord(value)))
  }
  return records
}

export async function abandonDurableEffect(
  stateRoot: string,
  identity: WorkflowIdentity,
  stepId: string,
  inputDigest: string
): Promise<void> {
  const root = await ensureStateRoot(stateRoot)
  const path = await resolveStatePath(
    root,
    `projects/${identity.projectId}/threads/${identity.threadId}/operations/${identity.operationId}/effects/${stepId}.json`
  )
  const value = await readJsonDocument(path, workflowStorageFailure)
  if (value === null) return
  const record = assertEffectRecord(asEffectRecord(value))
  if (
    record.operationId !== identity.operationId ||
    record.stepId !== stepId ||
    record.inputDigest !== inputDigest
  )
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '副作用记录与当前步骤不一致'
    })
  if (record.status !== 'started') return
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

export async function settleStartedDurableEffects(
  stateRoot: string,
  identity: WorkflowIdentity
): Promise<void> {
  const effects = await readDurableEffects(stateRoot, identity)
  for (const effect of effects) {
    if (effect.status !== 'started') continue
    await writeDurableEffect(stateRoot, identity, { ...effect, status: 'failed' })
  }
}

/**
 * 只把指定步骤仍为 started 的副作用标为失败。
 * 只用于调用方已证明本次没有落盘；已完成、结果不明或其它步骤保持原样。
 * @throws {AppException | WorkflowError} 记录与当前步骤不一致、损坏或写入失败。
 */
export async function failStartedDurableEffect(
  stateRoot: string,
  identity: WorkflowIdentity,
  stepId: string,
  inputDigest: string
): Promise<void> {
  const effects = await readDurableEffects(stateRoot, identity)
  const effect = effects.find((item) => item.stepId === stepId)
  if (!effect) return
  if (effect.inputDigest !== inputDigest)
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '副作用记录与当前步骤不一致'
    })
  if (effect.status !== 'started') return
  await writeDurableEffect(stateRoot, identity, { ...effect, status: 'failed' })
}

function isReliable(record: DurableEffectRecord): boolean {
  if (record.status !== 'completed' || !record.resultDigest) return false
  if (record.kind === 'fileWrite' || record.kind === 'commit')
    return Boolean(record.candidateRevision)
  return true
}

function assertEffectRecord(record: DurableEffectRecord): DurableEffectRecord {
  try {
    assertWorkflowSegment(record.operationId, 'operationId')
    assertWorkflowSegment(record.stepId, 'stepId')
  } catch (error) {
    throw new WorkflowError({
      category: 'recoveryBasisMissing',
      msg: '缺少可恢复依据',
      cause: error
    })
  }
  if (!record.inputDigest) {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  if (record.candidateRevision !== undefined) assertRevisionToken(record.candidateRevision)
  if (record.questions !== undefined) effectQuestions(record.questions)
  if (!isStatus(record.status) || !isKind(record.kind)) {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  return record
}

function asEffectRecord(value: unknown): DurableEffectRecord {
  if (!value || typeof value !== 'object') {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  const record = value as Partial<DurableEffectRecord>
  if (
    typeof record.operationId !== 'string' ||
    typeof record.stepId !== 'string' ||
    typeof record.inputDigest !== 'string' ||
    !isStatus(record.status) ||
    !isKind(record.kind)
  ) {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  const questions = 'questions' in record ? effectQuestions(record.questions) : undefined
  return {
    operationId: record.operationId,
    stepId: record.stepId,
    inputDigest: record.inputDigest,
    status: record.status,
    kind: record.kind,
    ...(typeof record.resultDigest === 'string' ? { resultDigest: record.resultDigest } : {}),
    ...(typeof record.candidateRevision === 'string'
      ? { candidateRevision: record.candidateRevision }
      : {}),
    ...(questions !== undefined ? { questions } : {})
  }
}

function isStatus(value: unknown): value is DurableEffectStatus {
  return value === 'started' || value === 'completed' || value === 'failed' || value === 'unknown'
}

function isKind(value: unknown): value is DurableEffectKind {
  return value === 'fileWrite' || value === 'commit' || value === 'none'
}

function effectQuestions(value: unknown): readonly DurableEffectQuestion[] {
  if (!Array.isArray(value) || value.length > 4) invalidEffect()
  const questions = value.map((item) => {
    if (!item || typeof item !== 'object') invalidEffect()
    const question = item as Record<string, unknown>
    const { questionId, prompt, detail, options } = question
    if (typeof questionId !== 'string' || questionId.trim() === '') invalidEffect()
    if (typeof prompt !== 'string' || prompt.trim() === '') invalidEffect()
    if (detail !== undefined && typeof detail !== 'string') invalidEffect()
    if (!Array.isArray(options) || options.length !== 3) invalidEffect()
    const parsedOptions = options.map((option) => {
      if (!option || typeof option !== 'object') invalidEffect()
      const row = option as Record<string, unknown>
      if (
        typeof row.id !== 'string' ||
        row.id.trim() === '' ||
        typeof row.label !== 'string' ||
        row.label.trim() === '' ||
        typeof row.description !== 'string' ||
        row.description.trim() === ''
      )
        invalidEffect()
      return { id: row.id, label: row.label, description: row.description }
    })
    if (new Set(parsedOptions.map((option) => option.id)).size !== parsedOptions.length)
      invalidEffect()
    return {
      questionId,
      prompt,
      ...(typeof detail === 'string' ? { detail } : {}),
      options: parsedOptions
    }
  })
  if (new Set(questions.map((question) => question.questionId)).size !== questions.length)
    invalidEffect()
  return questions
}

function invalidEffect(): never {
  throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
}
