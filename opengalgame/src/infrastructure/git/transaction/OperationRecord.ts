import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { resolveRepositoryMetadata } from '../containedPath'
import { decodeBytes, digestBytes, encodeBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import { writeJsonDocument, type StorageFailure } from '../../storage/jsonDocument'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

const operationRecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  phase: z.enum([
    'prepared',
    'files-applied',
    'index-updated',
    'object-written',
    'published',
    'rollback-required',
    'rolled-back'
  ]),
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
        .nullable()
    })
  ),
  indexBytesBase64: z.string(),
  indexDigest: z.string(),
  rollbackIndexBytesBase64: z.string().optional()
})

export type OperationPhase = z.infer<typeof operationRecordSchema>['phase']
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

/**
 * 返回操作记录在作品仓库中的路径。
 * @throws {AppException} 操作标识格式不正确。
 */
/**
 * @throws {AppException} 操作标识不正确，或记录目录越过仓库。
 */
export async function operationRecordPath(
  projectRoot: string,
  operationId: string
): Promise<string> {
  assertOperationId(operationId)
  const directory = await resolveRepositoryMetadata(projectRoot, ['opengalgame', 'operations'])
  return join(directory, `${operationId}.json`)
}

/**
 * @throws {AppException} 操作标识格式不正确。
 */
export function operationRef(operationId: string): string {
  assertOperationId(operationId)
  return `refs/opengalgame/operations/${operationId}`
}

/**
 * 读取操作记录。损坏时不抛错，由查询报告结果不明。
 * @returns 缺失、损坏或可用记录。
 * @throws {AppException} 记录文件无法读取。
 */
export async function readOperationRecord(
  projectRoot: string,
  operationId: string
): Promise<OperationRecordRead> {
  const path = await operationRecordPath(projectRoot, operationId)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品提交记录无法读取')
  }
  try {
    const parsed = operationRecordSchema.safeParse(JSON.parse(text))
    if (!parsed.success || parsed.data.operationId !== operationId) return { kind: 'damaged' }
    if (decodeBytes(parsed.data.indexBytesBase64) === null) return { kind: 'damaged' }
    if (
      parsed.data.rollbackIndexBytesBase64 &&
      decodeBytes(parsed.data.rollbackIndexBytesBase64) === null
    ) {
      return { kind: 'damaged' }
    }
    for (const pathRecord of parsed.data.paths) {
      if (
        pathRecord.originalBytesBase64 !== null &&
        decodeBytes(pathRecord.originalBytesBase64) === null
      ) {
        return { kind: 'damaged' }
      }
    }
    return { kind: 'ok', record: parsed.data }
  } catch {
    return { kind: 'damaged' }
  }
}

/**
 * @throws {AppException} 写入失败。
 */
export async function writeOperationRecord(
  projectRoot: string,
  record: OperationRecord
): Promise<void> {
  await writeJsonDocument(
    await operationRecordPath(projectRoot, record.operationId),
    record,
    recordFailure
  )
}

/** 用路径、动作和内容摘要生成操作内容指纹。 */
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

/**
 * @throws {AppException} 格式不正确。
 */
export function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作标识格式不正确' })
  }
}
