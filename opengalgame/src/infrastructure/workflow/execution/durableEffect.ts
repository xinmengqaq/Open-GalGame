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

/**
 * 决定副作用能否恢复。已完成且结果可靠时不重放；结果不明时停止。
 * @param verify - 核对实际文件或提交结果。结果不明时必须调用。
 * @returns 跳过、执行一次或停止恢复。
 * @throws {WorkflowError} 记录本身缺少身份或摘要。
 */
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

/**
 * 保存副作用记录。不执行文件写入或 Git 提交。
 * @throws {AppException | WorkflowError} 记录或路径不合法。
 */
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

/**
 * @returns 已保存的记录。目录不存在时为空。
 * @throws {WorkflowError | AppException} 记录损坏或路径越界。
 */
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

/**
 * 调用方已确认本步没有发生文件写入时，删除遗留的 started 记录。
 * 记录必须属于当前操作、步骤和输入摘要，否则拒绝；其他状态保持原样，文件不存在时静默返回。
 * @throws {AppException | WorkflowError} 记录与当前步骤不一致、损坏或删除失败。
 */
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

/**
 * 把当前操作里仍为 started 的副作用标为失败。
 * 已完成和结果不明的记录保持原样；不补结果摘要。
 * @throws {AppException | WorkflowError} 读取或写入失败时保留原因，不把未结算记录当成已失败。
 */
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

/** 已完成且带可靠结果的副作用不能无条件重放。 */
function isReliable(record: DurableEffectRecord): boolean {
  if (record.status !== 'completed' || !record.resultDigest) return false
  if (record.kind === 'fileWrite' || record.kind === 'commit')
    return Boolean(record.candidateRevision)
  return true
}

/**
 * @param record - 调用方记录。
 * @throws {WorkflowError} 记录缺少身份、步骤或输入摘要。
 */
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

/**
 * 把未知 JSON 收成副作用记录。缺字段时失败，不补默认状态。
 * @throws {WorkflowError} 文件不是完整记录。
 */
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

/** 题组必须原样可读。缺字段或形状不对时失败，不用空题组冒充旧记录。 */
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
