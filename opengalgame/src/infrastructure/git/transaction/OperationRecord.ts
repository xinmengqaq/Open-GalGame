import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import { resolveRepositoryMetadata } from '../containedPath'
import { decodeBytes, digestBytes, encodeBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import {
  isTemporaryDocumentName,
  listDocumentNames,
  writeJsonDocument,
  type StorageFailure
} from '../../storage/jsonDocument'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import {
  archiveLegacyOperationRecord,
  operationRecordModifiedAt,
  restoreLegacyOperationRecordIfUnchanged
} from './OperationRecordMigration'

const operationRecordShape = {
  formatVersion: z.literal(1),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  sourceModule: z.string().min(1).optional(),
  phase: z.enum([
    'prepared',
    'files-applied',
    'index-updated',
    'object-written',
    'published',
    'restoring',
    'compensated',
    'rollback-required',
    'rolled-back'
  ]),
  compensationBackupId: z
    .string()
    .regex(/^[\w-]{1,128}$/u)
    .optional(),
  rollbackBackupId: z
    .string()
    .regex(/^[\w-]{1,128}$/u)
    .optional(),
  baselineCommitId: z.string().regex(/^[0-9a-f]{40}$/u),
  branch: z.string().nullable(),
  fingerprint: z.string().min(1),
  candidateRevisionId: z.string().regex(/^[0-9a-f]{40}$/u),
  forwardCommitId: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  rollbackCommitId: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  paths: z.array(
    z.strictObject({
      relativePath: z.string().min(1),
      action: z.enum(['add', 'modify', 'delete']),
      originalBytesBase64: z.string().nullable(),
      intendedDigest: z.string().nullable(),
      originalStageOid: z
        .string()
        .regex(/^[0-9a-f]{40}$/u)
        .nullable(),
      intendedStageOid: z
        .string()
        .regex(/^[0-9a-f]{40}$/u)
        .nullable()
        .optional()
    })
  ),
  indexBytesBase64: z.string(),
  indexDigest: z.string()
} as const

const operationRecordSchema = z.strictObject(operationRecordShape)

const legacyOperationRecordSchema = z.strictObject({
  ...operationRecordShape,
  rollbackIndexBytesBase64: z.string().optional()
})

type LegacyOperationRecord = z.infer<typeof legacyOperationRecordSchema>

export type OperationRecord = z.infer<typeof operationRecordSchema>

export type OperationRecordRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'ok'; readonly record: OperationRecord }

const recordFailure: StorageFailure = {
  code: ProjectVersioningErrorCodes.gitUnavailable,
  msg: '作品提交记录写入失败',
  diskFull: {
    code: ProjectVersioningErrorCodes.gitUnavailable,
    msg: '磁盘空间不足，作品提交记录未写入'
  },
  notWritable: {
    code: ProjectVersioningErrorCodes.gitUnavailable,
    msg: '作品提交记录位置不可写'
  }
}

const recordTails = new Map<string, Promise<unknown>>()

function enqueueOperationRecord<T>(path: string, action: () => Promise<T>): Promise<T> {
  const resolved = resolve(path)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const previous = recordTails.get(key) ?? Promise.resolve()
  const result = previous.then(action, action)
  recordTails.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}

type RecordDocument =
  | { readonly kind: 'missing' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'json'; readonly bytes: Buffer; readonly value: unknown }

async function readRecordDocument(path: string): Promise<RecordDocument> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品提交记录无法读取')
  }
  try {
    return { kind: 'json', bytes, value: JSON.parse(bytes.toString('utf8')) }
  } catch {
    return { kind: 'damaged' }
  }
}

function parseCurrentRecord(value: unknown, expectedOperationId: string): OperationRecord | null {
  const parsed = operationRecordSchema.safeParse(value)
  if (!parsed.success || parsed.data.operationId !== expectedOperationId) return null
  if (decodeBytes(parsed.data.indexBytesBase64) === null) return null
  for (const pathRecord of parsed.data.paths) {
    if (
      pathRecord.originalBytesBase64 !== null &&
      decodeBytes(pathRecord.originalBytesBase64) === null
    ) {
      return null
    }
  }
  return parsed.data
}

function parseLegacyRecord(
  value: unknown,
  expectedOperationId: string
): LegacyOperationRecord | null {
  const parsed = legacyOperationRecordSchema.safeParse(value)
  if (!parsed.success || parsed.data.operationId !== expectedOperationId) return null
  if (decodeBytes(parsed.data.indexBytesBase64) === null) return null
  const rollbackIndex = parsed.data.rollbackIndexBytesBase64
  if (rollbackIndex !== undefined && decodeBytes(rollbackIndex) === null) return null
  for (const pathRecord of parsed.data.paths) {
    if (
      pathRecord.originalBytesBase64 !== null &&
      decodeBytes(pathRecord.originalBytesBase64) === null
    ) {
      return null
    }
  }
  return parsed.data
}

function normalizeLegacyRecord(legacy: LegacyOperationRecord): OperationRecord {
  const { rollbackIndexBytesBase64, ...rest } = legacy
  void rollbackIndexBytesBase64
  return operationRecordSchema.parse(rest)
}

function serializeOperationRecord(record: OperationRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function currentReadOf(document: RecordDocument, operationId: string): OperationRecordRead {
  if (document.kind === 'missing') return { kind: 'missing' }
  if (document.kind === 'damaged') return { kind: 'damaged' }
  const record = parseCurrentRecord(document.value, operationId)
  return record === null ? { kind: 'damaged' } : { kind: 'ok', record }
}

async function archiveLegacyBytes(
  projectRoot: string,
  path: string,
  operationId: string,
  sourceBytes: Buffer,
  legacy: LegacyOperationRecord
): Promise<void> {
  const encodedRollbackIndex = legacy.rollbackIndexBytesBase64
  if (encodedRollbackIndex === undefined) {
    throw new AppException({
      code: recordFailure.code,
      msg: '旧操作记录缺少可归档的旧字段'
    })
  }
  const rollbackIndex = decodeBytes(encodedRollbackIndex)
  if (rollbackIndex === null) {
    throw new AppException({
      code: recordFailure.code,
      msg: '旧操作记录字段无法解码，拒绝归档'
    })
  }
  await archiveLegacyOperationRecord({
    projectRoot,
    operationPath: path,
    operationId,
    sourceBytes,
    sourceModifiedAt: await operationRecordModifiedAt(path),
    legacyValueSha256: digestBytes(rollbackIndex),
    legacyValueByteLength: rollbackIndex.byteLength
  })
}

async function migrateLegacyRecord(
  projectRoot: string,
  operationId: string,
  path: string,
  sourceBytes: Buffer,
  legacy: LegacyOperationRecord
): Promise<OperationRecordRead> {
  const normalized = normalizeLegacyRecord(legacy)
  try {
    await archiveLegacyBytes(projectRoot, path, operationId, sourceBytes, legacy)
  } catch {
    return { kind: 'ok', record: normalized }
  }
  const beforeWrite = await readFile(path).catch(() => null)
  if (beforeWrite === null || !beforeWrite.equals(sourceBytes)) return { kind: 'damaged' }
  try {
    await writeJsonDocument(path, normalized, recordFailure)
  } catch {
    return { kind: 'ok', record: normalized }
  }

  const verified = currentReadOf(
    await readRecordDocument(path).catch(() => ({ kind: 'damaged' as const })),
    operationId
  )
  if (verified.kind === 'ok') return verified
  const restored = await restoreLegacyOperationRecordIfUnchanged({
    operationPath: path,
    expectedWrittenSha256: digestBytes(serializeOperationRecord(normalized)),
    sourceBytes
  }).catch(() => false)
  return restored ? { kind: 'ok', record: normalized } : { kind: 'damaged' }
}

async function readOperationRecordUnlocked(
  projectRoot: string,
  operationId: string,
  path: string
): Promise<OperationRecordRead> {
  const document = await readRecordDocument(path)
  const current = currentReadOf(document, operationId)
  if (current.kind !== 'damaged' || document.kind !== 'json') return current
  const legacy = parseLegacyRecord(document.value, operationId)
  if (legacy === null) return { kind: 'damaged' }
  return migrateLegacyRecord(projectRoot, operationId, path, document.bytes, legacy)
}

export async function operationRecordPath(
  projectRoot: string,
  operationId: string
): Promise<string> {
  assertOperationId(operationId)
  const directory = await resolveRepositoryMetadata(projectRoot, ['opengalgame', 'operations'])
  return join(directory, `${operationId}.json`)
}

export async function listOperationRecordIds(projectRoot: string): Promise<string[]> {
  const directory = await resolveRepositoryMetadata(projectRoot, ['opengalgame', 'operations'])
  const names = await listDocumentNames(directory, recordFailure)
  const ids: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || isTemporaryDocumentName(name)) continue
    const operationId = name.slice(0, -'.json'.length)
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '操作记录目录包含无法识别的文件'
      })
    }
    ids.push(operationId)
  }
  return ids
}

export function operationRef(operationId: string): string {
  assertOperationId(operationId)
  return `refs/opengalgame/operations/${operationId}`
}

export async function readOperationRecord(
  projectRoot: string,
  operationId: string
): Promise<OperationRecordRead> {
  const path = await operationRecordPath(projectRoot, operationId)
  return enqueueOperationRecord(path, () =>
    readOperationRecordUnlocked(projectRoot, operationId, path)
  )
}

export async function writeOperationRecord(
  projectRoot: string,
  record: OperationRecord
): Promise<void> {
  const parsed = operationRecordSchema.safeParse(record)
  if (!parsed.success) {
    throw new AppException({
      code: recordFailure.code,
      msg: recordFailure.msg
    })
  }
  const path = await operationRecordPath(projectRoot, record.operationId)
  await enqueueOperationRecord(path, async () => {
    const document = await readRecordDocument(path).catch((error: unknown) => {
      throw new AppException({
        code: recordFailure.code,
        msg: '作品提交记录写入前无法核对旧记录',
        cause: error
      })
    })
    if (document.kind === 'json') {
      const current = parseCurrentRecord(document.value, record.operationId)
      if (current === null) {
        const legacy = parseLegacyRecord(document.value, record.operationId)
        if (legacy !== null) {
          try {
            await archiveLegacyBytes(projectRoot, path, record.operationId, document.bytes, legacy)
          } catch (error) {
            throw new AppException({
              code: recordFailure.code,
              msg: '旧操作记录尚未完成归档，拒绝覆盖',
              cause: error
            })
          }
        }
      }
    }
    await writeJsonDocument(path, parsed.data, recordFailure)
  })
}

export function fingerprintChanges(
  changes: readonly { relativePath: string; action: string; intendedDigest: string | null }[]
): string {
  const canonical = changes
    .map((change) => `${change.action} ${change.relativePath} ${change.intendedDigest ?? '-'}`)
    .sort()
    .join('\n')
  return digestBytes(new TextEncoder().encode(canonical))
}

export function indexEvidence(bytes: Uint8Array): {
  indexBytesBase64: string
  indexDigest: string
} {
  return { indexBytesBase64: encodeBytes(bytes), indexDigest: digestBytes(bytes) }
}

export function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作标识格式不正确' })
  }
}
