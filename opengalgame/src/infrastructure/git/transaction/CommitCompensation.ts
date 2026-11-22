import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as git from 'isomorphic-git'

import { resolveContained, resolveRepositoryMetadata } from '../containedPath'
import { bytesEqual, decodeBytes, digestBytes } from '../objects/gitContent'
import type { GitEffects } from '../gitEffects'
import type { OperationRecord } from './OperationRecord'
import { readStageOids, readWorktreeBytes } from '../repository/WorkBaseline'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

export async function restoreRecordedFiles(
  projectRoot: string,
  record: OperationRecord,
  effects: GitEffects,
  appliedStageOids: ReadonlyMap<string, string | null>,
  options?: { readonly backupBeforeRestore?: boolean }
): Promise<void> {
  if (options?.backupBeforeRestore === true) {
    await restoreRecordedFilesWithBackup(projectRoot, record, effects)
    return
  }
  const stageOids = await readStageOids(
    projectRoot,
    record.paths.map((path) => path.relativePath)
  )
  for (const path of record.paths) {
    await restoreFile(projectRoot, path, effects)
    await restoreStage(
      projectRoot,
      path,
      stageOids.get(path.relativePath) ?? null,
      appliedStageOids,
      effects
    )
  }
}

type WorktreeBackup = {
  readonly kind: 'missing' | 'file'
  readonly digest: string | null
  readonly file: string | null
}

type StageBackup = {
  readonly oid: string | null
  readonly digest: string | null
  readonly file: string | null
}

type BackupPath = {
  readonly relativePath: string
  readonly worktree: WorktreeBackup
  readonly stage: StageBackup
  readonly originalStage: StageBackup
  readonly originalDigest: string | null
  readonly intendedStageOid: string | null
}

type CompensationBackupManifest = {
  readonly formatVersion: 1
  readonly operationId: string
  readonly sourceModule: string | null
  readonly baselineCommitId: string
  readonly fingerprint: string
  readonly attemptId: string
  readonly createdAt: string
  readonly paths: readonly BackupPath[]
}

type CompensationBackup = {
  readonly directory: string
  readonly attemptId: string
  readonly paths: ReadonlyMap<string, BackupPath>
}

export async function restoreRecordedFilesWithBackup(
  projectRoot: string,
  record: OperationRecord,
  effects: GitEffects,
  options?: {
    readonly mode?: 'compensate' | 'rollback'
    readonly restoreStage?: boolean
  }
): Promise<{ attemptId: string }> {
  const mode = options?.mode ?? 'compensate'
  const restoreStageEntries = options?.restoreStage !== false
  let backup: CompensationBackup
  try {
    backup = await createCompensationBackup(projectRoot, record, effects)
    await preflightCompensationBackup(projectRoot, record, backup)
  } catch (error) {
    if (error instanceof AppException) throw error
    throw backupFailure('恢复备份建立或校验失败，未写入正式路径', error)
  }
  try {
    await effects.writeRecord(
      projectRoot,
      mode === 'rollback'
        ? {
            ...record,
            phase: 'rollback-required',
            rollbackBackupId: backup.attemptId
          }
        : {
            ...record,
            phase: 'restoring',
            compensationBackupId: backup.attemptId
          }
    )
  } catch (error) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitUnavailable,
      msg: '恢复开始记录写入失败，正式路径未恢复',
      cause: error
    })
  }
  for (const path of record.paths) {
    const entry = backup.paths.get(path.relativePath)
    if (!entry) throw backupFailure('恢复备份缺少路径')
    await assertBackupCurrent(projectRoot, entry)
    try {
      await restoreFileFromBackup(projectRoot, path, effects)
      if (restoreStageEntries) await restoreStageFromBackup(projectRoot, path, effects)
    } catch (error) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitUnavailable,
        msg: '恢复未完成，备份已保留，需后续恢复',
        cause: error
      })
    }
  }
  if (mode === 'compensate') {
    try {
      await effects.writeRecord(projectRoot, {
        ...record,
        phase: 'compensated',
        compensationBackupId: backup.attemptId
      })
    } catch (error) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitUnavailable,
        msg: '补偿完成记录写入失败，备份已保留，按未完成恢复处理',
        cause: error
      })
    }
  }
  return { attemptId: backup.attemptId }
}

export async function verifyCompensationBackup(
  projectRoot: string,
  record: OperationRecord,
  attemptId: string
): Promise<void> {
  const directory = await resolveRepositoryMetadata(projectRoot, [
    'opengalgame',
    'compensation-backups',
    record.operationId,
    attemptId
  ])
  let parsed: Partial<CompensationBackupManifest>
  try {
    parsed = JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8')
    ) as Partial<CompensationBackupManifest>
  } catch (error) {
    throw backupFailure('补偿备份清单无法读取', error)
  }
  if (
    parsed.formatVersion !== 1 ||
    parsed.operationId !== record.operationId ||
    parsed.attemptId !== attemptId ||
    parsed.sourceModule !== (record.sourceModule ?? null) ||
    parsed.baselineCommitId !== record.baselineCommitId ||
    parsed.fingerprint !== record.fingerprint ||
    !Array.isArray(parsed.paths) ||
    parsed.paths.length !== record.paths.length
  ) {
    throw backupFailure('补偿备份清单与操作记录不一致')
  }
  const entries = new Map(parsed.paths.map((path) => [path.relativePath, path]))
  for (const path of record.paths) {
    const entry = entries.get(path.relativePath)
    if (
      !entry ||
      !entry.worktree ||
      !entry.stage ||
      !entry.originalStage ||
      entry.originalStage.oid !== path.originalStageOid ||
      entry.intendedStageOid !== (path.intendedStageOid ?? null)
    ) {
      throw backupFailure('补偿备份路径证据与操作记录不一致')
    }
    const original =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && !original) {
      throw backupFailure('操作记录原始字节无法读取')
    }
    if (entry.originalDigest !== (original === null ? null : digestBytes(original))) {
      throw backupFailure('操作记录原始字节摘要不一致')
    }
    await verifyBackupFile(directory, entry.worktree.file, entry.worktree.digest)
    await verifyBackupFile(directory, entry.stage.file, entry.stage.digest)
    await verifyBackupFile(directory, entry.originalStage.file, entry.originalStage.digest)
  }
}

async function preflightCompensationBackup(
  projectRoot: string,
  record: OperationRecord,
  backup: CompensationBackup
): Promise<void> {
  for (const entry of backup.paths.values()) {
    await verifyBackupFile(backup.directory, entry.worktree.file, entry.worktree.digest)
    await verifyBackupFile(backup.directory, entry.stage.file, entry.stage.digest)
    await verifyBackupFile(
      backup.directory,
      entry.originalStage.file,
      entry.originalStage.digest
    )
  }
  for (const path of record.paths) {
    const entry = backup.paths.get(path.relativePath)
    if (!entry) throw backupFailure('补偿备份缺少路径')
    await assertBackupCurrent(projectRoot, entry)
  }
}

async function verifyBackupFile(
  directory: string,
  fileName: string | null,
  digest: string | null
): Promise<void> {
  if (fileName === null) {
    if (digest !== null) throw backupFailure('补偿备份清单缺少字节文件')
    return
  }
  try {
    const bytes = new Uint8Array(await readFile(join(directory, fileName)))
    if (digest === null || digestBytes(bytes) !== digest) {
      throw backupFailure('补偿备份字节校验失败')
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    throw backupFailure('补偿备份字节无法读取', error)
  }
}

async function createCompensationBackup(
  projectRoot: string,
  record: OperationRecord,
  effects: GitEffects
): Promise<CompensationBackup> {
  const attemptId = randomUUID()
  const directory = await resolveRepositoryMetadata(projectRoot, [
    'opengalgame',
    'compensation-backups',
    record.operationId,
    attemptId
  ])
  try {
    await lstat(directory)
    throw backupFailure('补偿备份 attempt 已存在，拒绝覆盖')
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw backupFailure('补偿备份 attempt 无法核对', error)
    }
  }
  const stageOids = await readStageOids(
    projectRoot,
    record.paths.map((path) => path.relativePath)
  )
  const paths: BackupPath[] = []
  for (const [index, path] of record.paths.entries()) {
    const worktreeBytes = await readWorktreeForBackup(projectRoot, path.relativePath)
    const worktreeFile =
      worktreeBytes === null
        ? null
        : await writeBackupBytes(
            directory,
            `path-${index}-worktree.bin`,
            worktreeBytes,
            effects
          )
    const stageOid = stageOids.get(path.relativePath) ?? null
    const stageBytes = stageOid === null ? null : await readStageBytes(projectRoot, stageOid)
    const stageFile =
      stageBytes === null
        ? null
        : await writeBackupBytes(directory, `path-${index}-stage.bin`, stageBytes, effects)
    const originalStageBytes =
      path.originalStageOid === null
        ? null
        : await readStageBytes(projectRoot, path.originalStageOid)
    const originalStageFile =
      originalStageBytes === null
        ? null
        : await writeBackupBytes(
            directory,
            `path-${index}-original-stage.bin`,
            originalStageBytes,
            effects
          )
    const original =
      path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
    if (path.originalBytesBase64 !== null && !original) {
      throw backupFailure('操作记录原始字节无法读取')
    }
    paths.push({
      relativePath: path.relativePath,
      worktree: {
        kind: worktreeBytes === null ? 'missing' : 'file',
        digest: worktreeBytes === null ? null : digestBytes(worktreeBytes),
        file: worktreeFile
      },
      stage: {
        oid: stageOid,
        digest: stageBytes === null ? null : digestBytes(stageBytes),
        file: stageFile
      },
      originalStage: {
        oid: path.originalStageOid,
        digest: originalStageBytes === null ? null : digestBytes(originalStageBytes),
        file: originalStageFile
      },
      originalDigest: original === null ? null : digestBytes(original),
      intendedStageOid: path.intendedStageOid ?? null
    })
  }
  const manifest: CompensationBackupManifest = {
    formatVersion: 1,
    operationId: record.operationId,
    sourceModule: record.sourceModule ?? null,
    baselineCommitId: record.baselineCommitId,
    fingerprint: record.fingerprint,
    attemptId,
    createdAt: new Date().toISOString(),
    paths
  }
  await writeBackupManifest(directory, manifest, effects)
  return {
    directory,
    attemptId,
    paths: new Map(paths.map((path) => [path.relativePath, path]))
  }
}

async function readWorktreeForBackup(
  projectRoot: string,
  relativePath: string
): Promise<Uint8Array | null> {
  const absolute = await resolveContained(projectRoot, relativePath)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw backupFailure('工作区备份对象不是普通文件')
    }
    return new Uint8Array(await readFile(absolute))
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw backupFailure('工作区备份对象无法读取', error)
  }
}

async function readStageBytes(projectRoot: string, oid: string): Promise<Uint8Array> {
  try {
    const blob = await git.readBlob({ fs, dir: projectRoot, oid })
    return new Uint8Array(blob.blob)
  } catch (error) {
    throw backupFailure('暂存内容无法读取，不能保证恢复', error)
  }
}

async function writeBackupBytes(
  directory: string,
  fileName: string,
  bytes: Uint8Array,
  effects: GitEffects
): Promise<string> {
  const target = join(directory, fileName)
  await effects.writeBytes(target, bytes)
  try {
    const stored = new Uint8Array(await readFile(target))
    if (!bytesEqual(stored, bytes)) throw backupFailure('备份回读内容不一致')
  } catch (error) {
    if (error instanceof AppException) throw error
    throw backupFailure('备份回读失败', error)
  }
  return fileName
}

async function writeBackupManifest(
  directory: string,
  manifest: CompensationBackupManifest,
  effects: GitEffects
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const target = join(directory, 'manifest.json')
  await effects.writeBytes(target, bytes)
  try {
    const stored = new Uint8Array(await readFile(target))
    if (!bytesEqual(stored, bytes)) throw backupFailure('备份清单回读内容不一致')
    const parsed = JSON.parse(Buffer.from(stored).toString('utf8')) as Partial<
      CompensationBackupManifest
    >
    if (
      parsed.formatVersion !== 1 ||
      parsed.operationId !== manifest.operationId ||
      parsed.attemptId !== manifest.attemptId ||
      !Array.isArray(parsed.paths) ||
      parsed.paths.length !== manifest.paths.length
    ) {
      throw backupFailure('备份清单校验失败')
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    throw backupFailure('备份清单校验失败', error)
  }
}

async function assertBackupCurrent(
  projectRoot: string,
  entry: BackupPath
): Promise<void> {
  const current = await readWorktreeForBackup(projectRoot, entry.relativePath)
  if (entry.worktree.kind === 'missing') {
    if (current !== null) throw backupChanged()
  } else if (current === null || digestBytes(current) !== entry.worktree.digest) {
    throw backupChanged()
  }
  const stageOids = await readStageOids(projectRoot, [entry.relativePath])
  if ((stageOids.get(entry.relativePath) ?? null) !== entry.stage.oid) throw backupChanged()
}

async function restoreFileFromBackup(
  projectRoot: string,
  path: OperationRecord['paths'][number],
  effects: GitEffects
): Promise<void> {
  const original = path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
  if (path.originalBytesBase64 !== null && !original) throw backupFailure('原始字节无法还原')
  const absolute = await resolveContained(projectRoot, path.relativePath)
  if (original === null) await effects.removeFile(absolute)
  else await effects.writeBytes(absolute, original)
}

async function restoreStageFromBackup(
  projectRoot: string,
  path: OperationRecord['paths'][number],
  effects: GitEffects
): Promise<void> {
  await effects.stageBlob(projectRoot, path.relativePath, path.originalStageOid)
}

function backupFailure(message: string, cause?: unknown): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: message,
    cause
  })
}

function backupChanged(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: '备份后文件或索引已变化，已停止恢复'
  })
}

export async function restoreForwardFiles(
  projectRoot: string,
  record: OperationRecord,
  forwardFiles: readonly { relativePath: string; bytes: Uint8Array | null }[],
  stageBefore: ReadonlyMap<string, string | null>,
  appliedStageOids: ReadonlyMap<string, string | null>,
  effects: GitEffects
): Promise<void> {
  const stageOids = await readStageOids(
    projectRoot,
    forwardFiles.map((file) => file.relativePath)
  )
  for (const file of forwardFiles) {
    const absolute = await resolveContained(projectRoot, file.relativePath)
    const current = await readWorktreeBytes(projectRoot, file.relativePath)
    if (!sameBytes(current, file.bytes)) {
      const path = record.paths.find((item) => item.relativePath === file.relativePath)
      const original = path?.originalBytesBase64 ? decodeBytes(path.originalBytesBase64) : null
      if (!sameBytes(current, original)) throw foreignChange()
      if (file.bytes === null) await effects.removeFile(absolute)
      else await effects.writeBytes(absolute, file.bytes)
    }
    const currentOid = stageOids.get(file.relativePath) ?? null
    const before = stageBefore.get(file.relativePath) ?? null
    const applied = appliedStageOids.get(file.relativePath)
    if (currentOid === before) continue
    if (applied !== undefined && currentOid === applied) {
      await effects.stageBlob(projectRoot, file.relativePath, before)
      continue
    }
    throw foreignChange()
  }
}

async function restoreFile(
  projectRoot: string,
  path: OperationRecord['paths'][number],
  effects: GitEffects
): Promise<void> {
  const absolute = await resolveContained(projectRoot, path.relativePath)
  const original = path.originalBytesBase64 === null ? null : decodeBytes(path.originalBytesBase64)
  if (path.originalBytesBase64 !== null && !original) throw new Error('原始字节无法还原')
  const current = await readWorktreeBytes(projectRoot, path.relativePath)
  if (sameBytes(current, original)) return
  const currentDigest = current ? digestBytes(current) : null
  if (currentDigest !== path.intendedDigest) throw foreignChange()
  if (original === null) await effects.removeFile(absolute)
  else await effects.writeBytes(absolute, original)
}

async function restoreStage(
  projectRoot: string,
  path: OperationRecord['paths'][number],
  currentOid: string | null,
  appliedStageOids: ReadonlyMap<string, string | null>,
  effects: GitEffects
): Promise<void> {
  if (currentOid === path.originalStageOid) return
  const applied = appliedStageOids.get(path.relativePath)
  if (applied !== undefined && currentOid === applied) {
    await effects.stageBlob(projectRoot, path.relativePath, path.originalStageOid)
    return
  }
  throw foreignChange()
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right
  return bytesEqual(left, right)
}

function foreignChange(): Error {
  return new Error('文件或索引已有其他修改，不能恢复')
}
