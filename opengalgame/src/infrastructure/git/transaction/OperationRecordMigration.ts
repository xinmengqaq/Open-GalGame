import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

import { resolveRepositoryMetadata } from '../containedPath'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

/**
 * 产品首访迁移的 legacy 操作记录归档。
 *
 * 归属边界：归档位于作品仓库 `.git/opengalgame/legacy-operations`，只服务迁移与恢复，
 * 不是 R27 `migration:backup` 批次，也不改变 R27 要求备份根位于源根之外的外部备份策略。
 * manifest 使用 R27 原生 `legacy-data-backup` v1，可被现有 verify/restore CLI 直接消费。
 */

const MANIFEST_FORMAT_VERSION = 1
const MANIFEST_KIND = 'legacy-data-backup'
const TOOL_VERSION = 'opengalgame-r32/1'
const REPORT_FORMAT_VERSION = 1
const REPORT_KIND = 'operation-record-legacy-migration-report'
const LEGACY_FIELD = 'rollbackIndexBytesBase64'
const UNVISITED_NOTE = '产品首访迁移仅覆盖当前工程；未访问工程未扫描'
const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const OPERATION_BACKUP_PREFIX = 'files/project-0/.git/opengalgame/operations/'

const scopeSchema = z.strictObject({
  stateRoot: z.null(),
  projectRoots: z.array(z.string()).min(1),
  visitedProjects: z.array(z.string()).min(1),
  unvisitedProjects: z.strictObject({
    known: z.literal(false),
    count: z.null(),
    note: z.string().min(1)
  })
})

const manifestEntrySchema = z.strictObject({
  family: z.literal('operation'),
  originalPath: z.string().min(1),
  backupPath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256_PATTERN),
  modifiedAt: z.string().min(1),
  backedUpAt: z.string().min(1)
})

const manifestSchema = z.strictObject({
  formatVersion: z.literal(MANIFEST_FORMAT_VERSION),
  kind: z.literal(MANIFEST_KIND),
  batchId: z.string().regex(BATCH_ID_PATTERN),
  toolVersion: z.string().min(1),
  createdAt: z.string().min(1),
  backupRoot: z.string().min(1),
  scope: scopeSchema,
  entries: z.array(manifestEntrySchema).length(1)
})

const reportSchema = z.strictObject({
  formatVersion: z.literal(REPORT_FORMAT_VERSION),
  kind: z.literal(REPORT_KIND),
  toolVersion: z.literal(TOOL_VERSION),
  batchId: z.string().regex(BATCH_ID_PATTERN),
  operationId: z.string().min(1),
  operationPath: z.string().min(1),
  sourceSha256: z.string().regex(SHA256_PATTERN),
  sourceSizeBytes: z.number().int().nonnegative(),
  sourceModifiedAt: z.string().min(1),
  field: z.strictObject({
    name: z.literal(LEGACY_FIELD),
    disposition: z.literal('dropped-unused'),
    usedByRollback: z.literal(false),
    currentSchemaPresent: z.literal(false),
    currentConsumers: z.array(z.string()).max(0),
    basis: z.string().min(1),
    valueSha256: z.string().regex(SHA256_PATTERN),
    valueByteLength: z.number().int().nonnegative()
  }),
  scope: scopeSchema,
  archivedAt: z.string().min(1)
})

type Manifest = z.infer<typeof manifestSchema>
type Report = z.infer<typeof reportSchema>

export interface LegacyOperationArchiveInput {
  readonly projectRoot: string
  readonly operationPath: string
  readonly operationId: string
  readonly sourceBytes: Uint8Array
  readonly sourceModifiedAt: Date
  readonly legacyValueSha256: string
  readonly legacyValueByteLength: number
}

export interface LegacyOperationArchiveResult {
  readonly directory: string
  readonly batchId: string
  readonly reused: boolean
}

interface ArchiveExpectation {
  readonly projectRoot: string
  readonly operationPath: string
  readonly operationId: string
  readonly directory: string
  readonly batchId: string
  readonly sourceBytes: Uint8Array
  readonly sourceSha256: string
  readonly sourceSizeBytes: number
  readonly sourceModifiedAt: Date
  readonly legacyValueSha256: string
  readonly legacyValueByteLength: number
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => samePath(item, right[index]!))
}

function archiveFailure(message: string, cause?: unknown): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitUnavailable,
    msg: message,
    cause
  })
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw archiveFailure(`${label}不是合法 JSON`, error)
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assertIso(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw archiveFailure(`${label}不是 ISO-8601 时间`)
}

function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  return (async () => {
    const rootReal = await realpath(root).catch((error: unknown) => {
      throw archiveFailure('归档根无法解析', error)
    })
    const relativePath = relative(rootReal, target)
    if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw archiveFailure('归档路径越出归档根')
    }
    let current = rootReal
    for (const part of relativePath.split(sep)) {
      current = join(current, part)
      let info
      try {
        info = await lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw archiveFailure('归档路径无法检查', error)
      }
      if (info.isSymbolicLink()) throw archiveFailure('归档路径包含符号链接')
    }
  })()
}

async function readRegularFile(path: string, label: string): Promise<Buffer> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    throw archiveFailure(`${label}无法读取`, error)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw archiveFailure(`${label}不是普通文件`)
  }
  try {
    return await readFile(path)
  } catch (error) {
    throw archiveFailure(`${label}无法读取`, error)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw archiveFailure('归档路径无法检查', error)
  }
}

async function writeExclusiveFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 原子替换原始字节：同目录临时文件 + fsync + rename，绝不 copyFile 覆盖。 */
export async function writeOperationRecordBytesAtomically(
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.r32-record-tmp-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  try {
    await writeExclusiveFile(temporary, bytes)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw archiveFailure('操作记录原文回填失败', error)
  }
}

/**
 * 只有磁盘仍是本次归一写出的目标摘要时才回填原文；
 * 并发新写或删除不会被覆盖。
 */
export async function restoreLegacyOperationRecordIfUnchanged(input: {
  readonly operationPath: string
  readonly expectedWrittenSha256: string
  readonly sourceBytes: Uint8Array
}): Promise<boolean> {
  const disk = await readFile(input.operationPath).catch(() => null)
  if (disk === null || sha256Hex(disk) !== input.expectedWrittenSha256) return false
  await writeOperationRecordBytesAtomically(input.operationPath, input.sourceBytes)
  return true
}

function batchIdFor(projectRoot: string, operationPath: string, sourceSha256: string): string {
  const projectKey = sha256Hex(Buffer.from(projectRoot, 'utf8')).slice(0, 16)
  const operationKey = sha256Hex(Buffer.from(operationPath, 'utf8')).slice(0, 16)
  return `r32-${projectKey}-${operationKey}-${sourceSha256}`
}

function buildManifest(
  expectation: ArchiveExpectation,
  createdAt: string,
  backedUpAt: string
): Manifest {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    kind: MANIFEST_KIND,
    batchId: expectation.batchId,
    toolVersion: TOOL_VERSION,
    createdAt,
    backupRoot: expectation.directory,
    scope: {
      stateRoot: null,
      projectRoots: [expectation.projectRoot],
      visitedProjects: [expectation.projectRoot],
      unvisitedProjects: {
        known: false,
        count: null,
        note: UNVISITED_NOTE
      }
    },
    entries: [
      {
        family: 'operation',
        originalPath: expectation.operationPath,
        backupPath: `${OPERATION_BACKUP_PREFIX}${expectation.operationId}.json`,
        sizeBytes: expectation.sourceSizeBytes,
        sha256: expectation.sourceSha256,
        modifiedAt: expectation.sourceModifiedAt.toISOString(),
        backedUpAt
      }
    ]
  }
}

function buildReport(expectation: ArchiveExpectation, archivedAt: string): Report {
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    kind: REPORT_KIND,
    toolVersion: TOOL_VERSION,
    batchId: expectation.batchId,
    operationId: expectation.operationId,
    operationPath: expectation.operationPath,
    sourceSha256: expectation.sourceSha256,
    sourceSizeBytes: expectation.sourceSizeBytes,
    sourceModifiedAt: expectation.sourceModifiedAt.toISOString(),
    field: {
      name: LEGACY_FIELD,
      disposition: 'dropped-unused',
      usedByRollback: false,
      currentSchemaPresent: false,
      currentConsumers: [],
      basis:
        '当前写入方不再生成该字段，当前读取与提交/查询/回退均不消费它；回退事实由 paths[].originalBytesBase64、originalStageOid、phase 与 forward/rollbackCommitId 承担，整份索引快照回写会覆盖无关暂存路径，故不迁入 live 字段。',
      valueSha256: expectation.legacyValueSha256,
      valueByteLength: expectation.legacyValueByteLength
    },
    scope: {
      stateRoot: null,
      projectRoots: [expectation.projectRoot],
      visitedProjects: [expectation.projectRoot],
      unvisitedProjects: {
        known: false,
        count: null,
        note: UNVISITED_NOTE
      }
    },
    archivedAt
  }
}

function validateManifest(value: unknown, expectation: ArchiveExpectation): Manifest {
  const parsed = manifestSchema.safeParse(value)
  if (!parsed.success) throw archiveFailure('归档 manifest 结构不符合 R27 legacy-data-backup v1')
  const manifest = parsed.data
  if (manifest.batchId !== expectation.batchId) throw archiveFailure('归档 batchId 不匹配')
  if (manifest.toolVersion !== TOOL_VERSION) throw archiveFailure('归档 toolVersion 不匹配')
  assertIso(manifest.createdAt, 'manifest.createdAt')
  if (!isAbsolute(manifest.backupRoot) || !samePath(manifest.backupRoot, expectation.directory)) {
    throw archiveFailure('归档 backupRoot 与真实目录不一致')
  }
  if (!samePathList(manifest.scope.projectRoots, [expectation.projectRoot])) {
    throw archiveFailure('归档 scope.projectRoots 与真实工程不一致')
  }
  if (!samePathList(manifest.scope.visitedProjects, [expectation.projectRoot])) {
    throw archiveFailure('归档 scope.visitedProjects 与真实工程不一致')
  }
  if (manifest.scope.unvisitedProjects.note !== UNVISITED_NOTE) {
    throw archiveFailure('归档 scope.unvisitedProjects 说明不一致')
  }
  const entry = manifest.entries[0]!
  assertIso(entry.modifiedAt, 'manifest.entries[].modifiedAt')
  assertIso(entry.backedUpAt, 'manifest.entries[].backedUpAt')
  if (!samePath(entry.originalPath, expectation.operationPath)) {
    throw archiveFailure('归档原路径与操作记录路径不一致')
  }
  if (entry.backupPath !== `${OPERATION_BACKUP_PREFIX}${expectation.operationId}.json`) {
    throw archiveFailure('归档副本路径与操作记录身份不一致')
  }
  if (
    entry.sizeBytes !== expectation.sourceSizeBytes ||
    entry.sha256 !== expectation.sourceSha256
  ) {
    throw archiveFailure('归档条目与源字节不一致')
  }
  return manifest
}

function validateReport(value: unknown, expectation: ArchiveExpectation): Report {
  const parsed = reportSchema.safeParse(value)
  if (!parsed.success) throw archiveFailure('归档迁移报告结构不正确')
  const report = parsed.data
  if (report.batchId !== expectation.batchId) throw archiveFailure('迁移报告 batchId 不匹配')
  if (report.operationId !== expectation.operationId) throw archiveFailure('迁移报告操作身份不匹配')
  if (!samePath(report.operationPath, expectation.operationPath)) {
    throw archiveFailure('迁移报告记录路径不匹配')
  }
  if (
    report.sourceSha256 !== expectation.sourceSha256 ||
    report.sourceSizeBytes !== expectation.sourceSizeBytes
  ) {
    throw archiveFailure('迁移报告源字节事实不匹配')
  }
  assertIso(report.sourceModifiedAt, 'report.sourceModifiedAt')
  assertIso(report.archivedAt, 'report.archivedAt')
  if (
    report.field.valueSha256 !== expectation.legacyValueSha256 ||
    report.field.valueByteLength !== expectation.legacyValueByteLength
  ) {
    throw archiveFailure('迁移报告旧字段事实不匹配')
  }
  if (!samePathList(report.scope.projectRoots, [expectation.projectRoot])) {
    throw archiveFailure('迁移报告 scope.projectRoots 与真实工程不一致')
  }
  if (!samePathList(report.scope.visitedProjects, [expectation.projectRoot])) {
    throw archiveFailure('迁移报告 scope.visitedProjects 与真实工程不一致')
  }
  if (report.scope.unvisitedProjects.note !== UNVISITED_NOTE) {
    throw archiveFailure('迁移报告 scope.unvisitedProjects 说明不一致')
  }
  return report
}

async function readArchiveFiles(directory: string, expectation: ArchiveExpectation): Promise<void> {
  const directoryInfo = await lstat(directory).catch((error: unknown) => {
    throw archiveFailure('归档目录无法读取', error)
  })
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw archiveFailure('归档目录不是普通目录')
  }
  const manifestBytes = await readRegularFile(join(directory, 'manifest.json'), '归档 manifest')
  const manifest = validateManifest(parseJson(manifestBytes, '归档 manifest'), expectation)
  const reportBytes = await readRegularFile(join(directory, 'report.json'), '归档迁移报告')
  const report = validateReport(parseJson(reportBytes, '归档迁移报告'), expectation)
  if (Date.parse(manifest.entries[0]!.modifiedAt) !== Date.parse(report.sourceModifiedAt)) {
    throw archiveFailure('归档 manifest 与迁移报告的源修改时间不一致')
  }
  const backupFile = join(directory, ...manifest.entries[0]!.backupPath.split('/'))
  const backup = await readRegularFile(backupFile, '归档副本')
  if (
    backup.byteLength !== expectation.sourceSizeBytes ||
    sha256Hex(backup) !== expectation.sourceSha256
  ) {
    throw archiveFailure('归档副本字节与源记录不一致')
  }
}

async function expectedArchive(input: LegacyOperationArchiveInput): Promise<{
  expectation: ArchiveExpectation
  legacyRoot: string
}> {
  const projectRoot = await realpath(input.projectRoot).catch((error: unknown) => {
    throw archiveFailure('工程根无法解析', error)
  })
  const operationDirectory = await resolveRepositoryMetadata(input.projectRoot, [
    'opengalgame',
    'operations'
  ])
  const operationPath = join(operationDirectory, `${input.operationId}.json`)
  if (!samePath(operationPath, input.operationPath)) {
    throw archiveFailure('操作记录路径与工程元数据目录不一致')
  }
  const legacyRoot = await resolveRepositoryMetadata(input.projectRoot, [
    'opengalgame',
    'legacy-operations'
  ])
  const sourceSha256 = sha256Hex(input.sourceBytes)
  const batchId = batchIdFor(projectRoot, operationPath, sourceSha256)
  return {
    expectation: {
      projectRoot,
      operationPath,
      operationId: input.operationId,
      directory: join(legacyRoot, batchId),
      batchId,
      sourceBytes: input.sourceBytes,
      sourceSha256,
      sourceSizeBytes: input.sourceBytes.byteLength,
      sourceModifiedAt: input.sourceModifiedAt,
      legacyValueSha256: input.legacyValueSha256,
      legacyValueByteLength: input.legacyValueByteLength
    },
    legacyRoot
  }
}

/**
 * 首访归档：已存在且完整匹配时复用；不存在时先写同根临时目录，完整校验后整体 rename 发布。
 * 归档损坏、链接、写入或 rename 失败都会抛出，调用方保留 legacy 原文。
 */
export async function archiveLegacyOperationRecord(
  input: LegacyOperationArchiveInput
): Promise<LegacyOperationArchiveResult> {
  const { expectation, legacyRoot } = await expectedArchive(input)
  if (await pathExists(expectation.directory)) {
    await assertNoSymlinkComponents(legacyRoot, expectation.directory)
    await readArchiveFiles(expectation.directory, expectation)
    return { directory: expectation.directory, batchId: expectation.batchId, reused: true }
  }

  await mkdir(legacyRoot, { recursive: true }).catch((error: unknown) => {
    throw archiveFailure('归档根无法创建', error)
  })
  await assertNoSymlinkComponents(legacyRoot, expectation.directory)

  const staging = join(legacyRoot, `.r32-archive-tmp-${randomUUID()}`)
  const stagedAt = new Date().toISOString()
  try {
    await mkdir(staging)
    const manifest = buildManifest(expectation, stagedAt, stagedAt)
    const report = buildReport(expectation, stagedAt)
    const stagingEntry = join(staging, ...manifest.entries[0]!.backupPath.split('/'))
    await mkdir(dirname(stagingEntry), { recursive: true })
    await writeExclusiveFile(stagingEntry, expectation.sourceBytes)
    await writeExclusiveFile(join(staging, 'manifest.json'), jsonBytes(manifest))
    await writeExclusiveFile(join(staging, 'report.json'), jsonBytes(report))
    await readArchiveFiles(staging, expectation)
    if (await pathExists(expectation.directory)) {
      throw archiveFailure('归档目录在发布前出现，拒绝覆盖已发布批次')
    }
    await rename(staging, expectation.directory)
  } catch (error) {
    // 只清理本次独占且尚未发布的 staging；已发布目录即使复验失败也保留并拒绝迁移。
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if (await pathExists(expectation.directory).catch(() => false)) {
      try {
        await readArchiveFiles(expectation.directory, expectation)
        return { directory: expectation.directory, batchId: expectation.batchId, reused: true }
      } catch {
        // 已存在目录不完整或与源不符，保留原文并报错，绝不删除/覆盖。
      }
    }
    throw error instanceof AppException ? error : archiveFailure('归档写入失败', error)
  }

  await readArchiveFiles(expectation.directory, expectation)
  return { directory: expectation.directory, batchId: expectation.batchId, reused: false }
}

/** 读取源记录的真实修改时间；文件缺失或不可读时由调用方按失败处理。 */
export async function operationRecordModifiedAt(path: string): Promise<Date> {
  try {
    return (await stat(path)).mtime
  } catch (error) {
    throw archiveFailure('操作记录修改时间无法读取', error)
  }
}
