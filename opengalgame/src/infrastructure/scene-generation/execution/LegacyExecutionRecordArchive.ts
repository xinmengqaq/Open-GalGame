import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { mapStorageFailure } from '@infrastructure/storage/jsonDocument'
import {
  executionDocumentSchema,
  SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION
} from './SceneGenerationExecutionDocument'
import {
  LEGACY_EXECUTION_RECORD_REASONS,
  isUnfinishedLegacyOperationState,
  legacyExecutionRecordReason,
  legacyExecutionRecordTimeFacts,
  legacyOperationFactSchema,
  migrateExecutionDocument,
  type LegacyExecutionRecordReason
} from './LegacyExecutionRecordDocument'

const failure = { code: ErrorCodes.internalError, msg: '场景生成执行记录读写失败' }
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RESERVED_PROJECTS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'lpt1', 'lpt2'])
const POLLUTED_PROJECTS = new Set(['__proto__', 'constructor', 'prototype'])
const EXECUTION_RELATIVE_PATTERN =
  /^scene-generation\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/executions\.json$/
const LEGACY_RECORD_KEYS = [
  'projectId',
  'sceneId',
  'operationId',
  'threadId',
  'branchId',
  'fingerprint',
  'state',
  'hasCreatedAt',
  'hasUpdatedAt',
  'hasTimeline',
  'rawSha256',
  'reason'
] as const
const LEGACY_IDENTITY_KEYS = [
  'projectId',
  'sceneId',
  'operationId',
  'threadId',
  'branchId',
  'fingerprint',
  'state'
] as const

export const EXECUTION_ARCHIVE_FORMAT_VERSION = 1
export const EXECUTION_ARCHIVE_KIND = 'execution-record-legacy-archive'
export const EXECUTION_ARCHIVE_TOOL_VERSION = '1'
export const EXECUTION_ARCHIVE_SOURCE_FILE = 'source.json'
export const EXECUTION_ARCHIVE_MANIFEST_FILE = 'manifest.json'
export const EXECUTION_ARCHIVE_READ_RESPONSIBILITY = 'migration-and-restore-tools-only'

export interface ExecutionArchiveLegacyRecord {
  readonly projectId: string
  readonly sceneId: string
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly fingerprint: string
  readonly state: string
  readonly hasCreatedAt: boolean
  readonly hasUpdatedAt: boolean
  readonly hasTimeline: boolean
  readonly rawSha256: string
  readonly reason: LegacyExecutionRecordReason
}

export interface ExecutionArchiveManifest {
  readonly formatVersion: number
  readonly kind: string
  readonly toolVersion: string
  readonly batchId: string
  readonly createdAt: string
  readonly reason: 'pre-migration-backup'
  readonly source: {
    readonly projectId: string
    readonly relativePath: string
    readonly envelopeVersion: number
    readonly sizeBytes: number
    readonly sha256: string
    readonly modifiedAt: string
  }
  readonly target: {
    readonly envelopeVersion: number
    readonly sha256: string
  }
  readonly counts: {
    readonly total: number
    readonly current: number
    readonly legacy: number
  }
  readonly legacyRecords: readonly ExecutionArchiveLegacyRecord[]
  readonly coverage: {
    readonly stateRoot: string
    readonly visitedProjects: readonly string[]
    readonly unvisitedProjects: {
      readonly known: boolean
      readonly count: number | null
      readonly note: string
    }
  }
  readonly readResponsibility: string
  readonly productDataSource: boolean
}

export interface WriteExecutionRecordArchiveInput {
  readonly stateRoot: string
  readonly projectId: string
  readonly relativePath: string
  readonly sourceBytes: Buffer
  readonly sourceSha256: string
  readonly envelopeVersion: number
  readonly modifiedAt: string
  readonly targetSha256: string
  readonly counts: ExecutionArchiveManifest['counts']
  readonly legacyRecords: readonly ExecutionArchiveLegacyRecord[]
}

export interface ExecutionRecordArchiveResult {
  readonly directory: string
  readonly manifest: ExecutionArchiveManifest
  readonly reused: boolean
}

export interface ReadExecutionRecordArchiveExpectation {
  readonly projectId: string
  readonly relativePath: string
  readonly sourceSha256: string
  readonly targetSha256?: string
  readonly stateRoot?: string
}

function archiveFailure(message: string, cause?: unknown): AppException {
  return new AppException({ ...failure, msg: message, cause })
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function serializeJsonDocument(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function executionRecordRelativePath(projectId: string): string {
  return `scene-generation/projects/${assertProjectSegment(projectId)}/executions.json`
}

export function assertProjectSegment(projectId: string): string {
  if (
    typeof projectId !== 'string' ||
    !PROJECT_SEGMENT.test(projectId) ||
    projectId === '.' ||
    projectId === '..' ||
    RESERVED_PROJECTS.has(projectId.toLowerCase()) ||
    POLLUTED_PROJECTS.has(projectId)
  )
    throw archiveFailure('执行记录工程标识无效')
  return projectId
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function samePath(left: string, right: string): boolean {
  return pathKey(resolve(left)) === pathKey(resolve(right))
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw archiveFailure(`${label}必须是对象`)
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw archiveFailure(`${label}字段不符合执行记录归档格式`)
  return record
}

function assertIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw archiveFailure(`${label}必须是 ISO-8601 时间`)
  return value
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw archiveFailure(`${label}必须是非负整数`)
  return value
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value))
    throw archiveFailure(`${label}必须是 64 位小写十六进制摘要`)
  return value
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw archiveFailure(`${label}必须是非空字符串`)
  return value
}

function assertLegacyReason(value: unknown): LegacyExecutionRecordReason {
  if (
    typeof value !== 'string' ||
    !(LEGACY_EXECUTION_RECORD_REASONS as readonly string[]).includes(value)
  )
    throw archiveFailure('归档记录原因不在约定枚举内')
  return value as LegacyExecutionRecordReason
}

function assertLegacyRecord(
  value: unknown,
  manifestSource: ExecutionArchiveManifest['source']
): ExecutionArchiveLegacyRecord {
  const record = assertExactKeys(value, LEGACY_RECORD_KEYS, 'manifest.legacyRecords[]')
  const fact = legacyOperationFactSchema.safeParse({
    projectId: record.projectId,
    sceneId: record.sceneId,
    operationId: record.operationId,
    threadId: record.threadId,
    branchId: record.branchId,
    fingerprint: record.fingerprint,
    state: record.state
  })
  if (!fact.success || fact.data.projectId !== manifestSource.projectId)
    throw archiveFailure('归档记录身份与工程不一致')
  for (const key of ['hasCreatedAt', 'hasUpdatedAt', 'hasTimeline'] as const) {
    if (typeof record[key] !== 'boolean') throw archiveFailure('归档记录时间事实必须是布尔值')
  }
  const hasCreatedAt = record.hasCreatedAt as boolean
  const hasUpdatedAt = record.hasUpdatedAt as boolean
  const hasTimeline = record.hasTimeline as boolean
  const rawSha256 = assertSha256(record.rawSha256, 'manifest.legacyRecords[].rawSha256')
  const reason = assertLegacyReason(record.reason)
  const expectedReason =
    hasCreatedAt || hasUpdatedAt || hasTimeline
      ? 'current-schema-incomplete'
      : 'missing-record-time'
  if (reason !== expectedReason) throw archiveFailure('归档记录原因与已有时间事实不一致')
  return {
    ...fact.data,
    hasCreatedAt,
    hasUpdatedAt,
    hasTimeline,
    rawSha256,
    reason
  }
}

export function validateExecutionArchiveManifest(
  value: unknown,
  expected?: Partial<ReadExecutionRecordArchiveExpectation>
): ExecutionArchiveManifest {
  const manifest = assertExactKeys(
    value,
    [
      'formatVersion',
      'kind',
      'toolVersion',
      'batchId',
      'createdAt',
      'reason',
      'source',
      'target',
      'counts',
      'legacyRecords',
      'coverage',
      'readResponsibility',
      'productDataSource'
    ],
    'manifest'
  )
  if (manifest.formatVersion !== EXECUTION_ARCHIVE_FORMAT_VERSION)
    throw archiveFailure('执行记录归档版本不受支持')
  if (manifest.kind !== EXECUTION_ARCHIVE_KIND) throw archiveFailure('执行记录归档类型不受支持')
  const toolVersion = assertText(manifest.toolVersion, 'manifest.toolVersion')
  if (typeof manifest.batchId !== 'string' || !BATCH_ID_PATTERN.test(manifest.batchId))
    throw archiveFailure('manifest.batchId 格式非法')
  const createdAt = assertIso(manifest.createdAt, 'manifest.createdAt')
  if (manifest.reason !== 'pre-migration-backup') throw archiveFailure('执行记录归档原因不受支持')

  const source = assertExactKeys(
    manifest.source,
    ['projectId', 'relativePath', 'envelopeVersion', 'sizeBytes', 'sha256', 'modifiedAt'],
    'manifest.source'
  )
  const projectId = assertProjectSegment(assertText(source.projectId, 'manifest.source.projectId'))
  const relativePath = assertText(source.relativePath, 'manifest.source.relativePath')
  const relativeMatch = EXECUTION_RELATIVE_PATTERN.exec(relativePath)
  if (!relativeMatch || relativeMatch[1] !== projectId)
    throw archiveFailure('执行记录归档来源路径与工程不一致')
  if (
    typeof source.envelopeVersion !== 'number' ||
    !Number.isInteger(source.envelopeVersion) ||
    source.envelopeVersion < 1 ||
    source.envelopeVersion > SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION
  )
    throw archiveFailure('执行记录归档来源版本不受支持')
  const sizeBytes = assertNonNegativeInteger(source.sizeBytes, 'manifest.source.sizeBytes')
  const sourceSha256 = assertSha256(source.sha256, 'manifest.source.sha256')
  const modifiedAt = assertIso(source.modifiedAt, 'manifest.source.modifiedAt')

  const target = assertExactKeys(manifest.target, ['envelopeVersion', 'sha256'], 'manifest.target')
  if (target.envelopeVersion !== SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION)
    throw archiveFailure('执行记录归档目标版本必须是当前版本')
  const targetSha256 = assertSha256(target.sha256, 'manifest.target.sha256')

  const counts = assertExactKeys(manifest.counts, ['total', 'current', 'legacy'], 'manifest.counts')
  const total = assertNonNegativeInteger(counts.total, 'manifest.counts.total')
  const current = assertNonNegativeInteger(counts.current, 'manifest.counts.current')
  const legacy = assertNonNegativeInteger(counts.legacy, 'manifest.counts.legacy')
  if (total !== current + legacy) throw archiveFailure('执行记录归档计数不自洽')

  if (!Array.isArray(manifest.legacyRecords))
    throw archiveFailure('manifest.legacyRecords 必须是数组')
  if (manifest.legacyRecords.length !== legacy)
    throw archiveFailure('执行记录归档 legacy 计数与记录不一致')
  const legacyRecords = manifest.legacyRecords.map((item) =>
    assertLegacyRecord(item, {
      projectId,
      relativePath,
      envelopeVersion: source.envelopeVersion as number,
      sizeBytes,
      sha256: sourceSha256,
      modifiedAt
    })
  )
  const operationIds = new Set<string>()
  for (const record of legacyRecords) {
    if (operationIds.has(record.operationId))
      throw archiveFailure('执行记录归档 legacy 操作标识重复')
    operationIds.add(record.operationId)
  }

  const coverage = assertExactKeys(
    manifest.coverage,
    ['stateRoot', 'visitedProjects', 'unvisitedProjects'],
    'manifest.coverage'
  )
  if (typeof coverage.stateRoot !== 'string' || !isAbsolute(coverage.stateRoot))
    throw archiveFailure('manifest.coverage.stateRoot 必须是绝对路径')
  if (!Array.isArray(coverage.visitedProjects) || coverage.visitedProjects.length !== 1)
    throw archiveFailure('manifest.coverage.visitedProjects 必须只登记本次迁移工程')
  if (coverage.visitedProjects[0] !== projectId)
    throw archiveFailure('manifest.coverage.visitedProjects 与工程不一致')
  const unvisited = assertExactKeys(
    coverage.unvisitedProjects,
    ['known', 'count', 'note'],
    'manifest.coverage.unvisitedProjects'
  )
  if (unvisited.known !== false || unvisited.count !== null)
    throw archiveFailure('manifest.coverage.unvisitedProjects 不得声称已知未访问工程')
  const note = assertText(unvisited.note, 'manifest.coverage.unvisitedProjects.note')

  if (manifest.readResponsibility !== EXECUTION_ARCHIVE_READ_RESPONSIBILITY)
    throw archiveFailure('manifest.readResponsibility 必须是工具专用')
  if (manifest.productDataSource !== false)
    throw archiveFailure('manifest.productDataSource 必须为 false')

  if (expected?.projectId !== undefined && expected.projectId !== projectId)
    throw archiveFailure('执行记录归档工程与预期不一致')
  if (expected?.relativePath !== undefined && expected.relativePath !== relativePath)
    throw archiveFailure('执行记录归档来源路径与预期不一致')
  if (expected?.sourceSha256 !== undefined && expected.sourceSha256 !== sourceSha256)
    throw archiveFailure('执行记录归档来源摘要与预期不一致')
  if (expected?.targetSha256 !== undefined && expected.targetSha256 !== targetSha256)
    throw archiveFailure('执行记录归档目标摘要与预期不一致')
  if (expected?.stateRoot !== undefined && !samePath(expected.stateRoot, coverage.stateRoot))
    throw archiveFailure('执行记录归档状态根与预期不一致')

  return {
    formatVersion: EXECUTION_ARCHIVE_FORMAT_VERSION,
    kind: EXECUTION_ARCHIVE_KIND,
    toolVersion,
    batchId: manifest.batchId,
    createdAt,
    reason: 'pre-migration-backup',
    source: {
      projectId,
      relativePath,
      envelopeVersion: source.envelopeVersion as number,
      sizeBytes,
      sha256: sourceSha256,
      modifiedAt
    },
    target: {
      envelopeVersion: SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION,
      sha256: targetSha256
    },
    counts: { total, current, legacy },
    legacyRecords,
    coverage: {
      stateRoot: coverage.stateRoot,
      visitedProjects: [projectId],
      unvisitedProjects: { known: false, count: null, note }
    },
    readResponsibility: EXECUTION_ARCHIVE_READ_RESPONSIBILITY,
    productDataSource: false
  }
}

export function validateExecutionArchiveSource(
  manifest: ExecutionArchiveManifest,
  sourceBytes: Uint8Array
): void {
  if (sourceBytes.byteLength !== manifest.source.sizeBytes)
    throw archiveFailure('执行记录归档源文件大小与 manifest 不一致')
  if (sha256Hex(sourceBytes) !== manifest.source.sha256)
    throw archiveFailure('执行记录归档源文件摘要与 manifest 不一致')

  let value: unknown
  try {
    value = JSON.parse(Buffer.from(sourceBytes).toString('utf8'))
  } catch (error) {
    throw archiveFailure('执行记录归档源文件不是合法 JSON', error)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw archiveFailure('执行记录归档源文件缺少信封')
  const envelope = value as Record<string, unknown>
  if (envelope.version !== manifest.source.envelopeVersion)
    throw archiveFailure('执行记录归档源文件版本与 manifest 不一致')
  const executions = envelope.executions
  if (!Array.isArray(executions) || executions.length !== manifest.counts.total)
    throw archiveFailure('执行记录归档源文件记录数或结构不符合 manifest')

  const expectedLegacy = new Map(
    manifest.legacyRecords.map((record) => [record.operationId, record])
  )
  const seen = new Set<string>()
  let current = 0
  for (const raw of executions) {
    const migrated = migrateExecutionDocument(raw)
    const parsed = executionDocumentSchema.safeParse(migrated)
    if (parsed.success) {
      if (parsed.data.projectId !== manifest.source.projectId)
        throw archiveFailure('执行记录归档源文件含其他工程的当前记录')
      current += 1
      continue
    }
    const fact = legacyOperationFactSchema.safeParse(raw)
    if (!fact.success || fact.data.projectId !== manifest.source.projectId)
      throw archiveFailure('执行记录归档源文件含无法归属的旧记录')
    const record = expectedLegacy.get(fact.data.operationId)
    if (!record) throw archiveFailure('执行记录归档源文件旧记录未登记到 manifest')
    if (seen.has(fact.data.operationId)) throw archiveFailure('执行记录归档源文件旧记录标识重复')
    seen.add(fact.data.operationId)
    for (const key of LEGACY_IDENTITY_KEYS) {
      if (record[key] !== fact.data[key]) throw archiveFailure('归档旧记录身份与源文件不一致')
    }
    const timeFacts = legacyExecutionRecordTimeFacts(raw)
    if (
      record.hasCreatedAt !== timeFacts.hasCreatedAt ||
      record.hasUpdatedAt !== timeFacts.hasUpdatedAt ||
      record.hasTimeline !== timeFacts.hasTimeline
    )
      throw archiveFailure('归档旧记录时间事实与源文件不一致')
    if (sha256Hex(Buffer.from(JSON.stringify(raw), 'utf8')) !== record.rawSha256)
      throw archiveFailure('归档旧记录原始摘要与源文件不一致')
    if (legacyExecutionRecordReason(raw) !== record.reason)
      throw archiveFailure('归档旧记录原因与源文件不一致')
  }
  if (current !== manifest.counts.current || seen.size !== manifest.counts.legacy)
    throw archiveFailure('执行记录归档源文件分类计数与 manifest 不一致')
}

async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw mapStorageFailure(error, failure)
  }
}

async function assertNoSymlinkComponents(
  root: string,
  target: string,
  label: string
): Promise<void> {
  if (!isInside(root, target)) throw archiveFailure(`${label}越出状态根`)
  const rel = relative(root, target)
  if (rel === '') return
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    const stats = await lstatIfExists(current)
    if (stats === null) return
    if (stats.isSymbolicLink()) throw archiveFailure(`${label}包含符号链接，拒绝执行`)
  }
}

async function readRegularFile(path: string, label: string): Promise<Buffer> {
  const stats = await lstatIfExists(path)
  if (stats === null) throw archiveFailure(`${label}不存在`)
  if (stats.isSymbolicLink() || !stats.isFile()) throw archiveFailure(`${label}不是普通文件`)
  try {
    return await readFile(path)
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
}

async function readArchiveFiles(
  directory: string,
  expectation: ReadExecutionRecordArchiveExpectation,
  requireDirectoryName: boolean
): Promise<{ manifest: ExecutionArchiveManifest; sourceBytes: Buffer }> {
  const stats = await lstatIfExists(directory)
  if (stats === null) throw archiveFailure('执行记录归档目录不存在')
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw archiveFailure('执行记录归档目录不是普通目录')
  const sourceBytes = await readRegularFile(
    join(directory, EXECUTION_ARCHIVE_SOURCE_FILE),
    '归档源文件'
  )
  const manifestBytes = await readRegularFile(
    join(directory, EXECUTION_ARCHIVE_MANIFEST_FILE),
    '归档 manifest'
  )
  let value: unknown
  try {
    value = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw archiveFailure('归档 manifest 不是合法 JSON', error)
  }
  const manifest = validateExecutionArchiveManifest(value, expectation)
  if (requireDirectoryName && basename(directory) !== manifest.source.sha256)
    throw archiveFailure('执行记录归档目录名与来源摘要不一致')
  validateExecutionArchiveSource(manifest, sourceBytes)
  return { manifest, sourceBytes }
}

export async function readExecutionRecordArchive(
  directory: string,
  expectation: ReadExecutionRecordArchiveExpectation
): Promise<{ manifest: ExecutionArchiveManifest; sourceBytes: Buffer }> {
  return readArchiveFiles(directory, expectation, true)
}

async function writeExclusiveFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeBytesAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.opengalgame-tmp-${randomUUID()}`)
  try {
    await writeExclusiveFile(temporary, bytes)
    try {
      await rename(temporary, path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await copyFile(temporary, path)
      await rm(temporary, { force: true })
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw mapStorageFailure(error, failure)
  }
}

function buildManifest(
  input: WriteExecutionRecordArchiveInput,
  stateRoot: string
): ExecutionArchiveManifest {
  return {
    formatVersion: EXECUTION_ARCHIVE_FORMAT_VERSION,
    kind: EXECUTION_ARCHIVE_KIND,
    toolVersion: EXECUTION_ARCHIVE_TOOL_VERSION,
    batchId: randomUUID(),
    createdAt: new Date().toISOString(),
    reason: 'pre-migration-backup',
    source: {
      projectId: input.projectId,
      relativePath: input.relativePath,
      envelopeVersion: input.envelopeVersion,
      sizeBytes: input.sourceBytes.byteLength,
      sha256: input.sourceSha256,
      modifiedAt: input.modifiedAt
    },
    target: {
      envelopeVersion: SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION,
      sha256: input.targetSha256
    },
    counts: { ...input.counts },
    legacyRecords: input.legacyRecords.map((record) => ({ ...record })),
    coverage: {
      stateRoot,
      visitedProjects: [input.projectId],
      unvisitedProjects: {
        known: false,
        count: null,
        note: '产品只迁移被读取的工程，未扫描其他工程'
      }
    },
    readResponsibility: EXECUTION_ARCHIVE_READ_RESPONSIBILITY,
    productDataSource: false
  }
}

export async function writeExecutionRecordArchive(
  input: WriteExecutionRecordArchiveInput
): Promise<ExecutionRecordArchiveResult> {
  const projectId = assertProjectSegment(input.projectId)
  const expectedRelative = executionRecordRelativePath(projectId)
  if (input.relativePath !== expectedRelative)
    throw archiveFailure('执行记录归档来源路径与工程不一致')
  if (sha256Hex(input.sourceBytes) !== input.sourceSha256)
    throw archiveFailure('执行记录归档来源摘要与字节不一致')
  if (input.counts.total !== input.counts.current + input.counts.legacy)
    throw archiveFailure('执行记录归档计数不自洽')
  if (input.counts.legacy !== input.legacyRecords.length)
    throw archiveFailure('执行记录归档 legacy 计数与记录不一致')
  const unfinished = input.legacyRecords.filter((record) =>
    isUnfinishedLegacyOperationState(record.state)
  )
  if (unfinished.length > 0)
    throw archiveFailure('未结束的旧记录不能归档升级，请先在旧版完成或取消该操作')

  let stateRoot: string
  try {
    stateRoot = await realpath(input.stateRoot)
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
  const archiveRoot = join(
    stateRoot,
    'scene-generation',
    'projects',
    projectId,
    'legacy-executions'
  )
  await assertNoSymlinkComponents(stateRoot, archiveRoot, '执行记录归档目录')
  try {
    await mkdir(archiveRoot, { recursive: true })
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
  await assertNoSymlinkComponents(stateRoot, archiveRoot, '执行记录归档目录')

  const directory = join(archiveRoot, input.sourceSha256)
  const expectation: ReadExecutionRecordArchiveExpectation = {
    projectId,
    relativePath: expectedRelative,
    sourceSha256: input.sourceSha256,
    targetSha256: input.targetSha256,
    stateRoot
  }
  const existing = await lstatIfExists(directory)
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw archiveFailure('执行记录归档路径已被非归档内容占用')
    const archived = await readExecutionRecordArchive(directory, expectation)
    return { directory, manifest: archived.manifest, reused: true }
  }

  const manifest = buildManifest({ ...input, projectId, relativePath: expectedRelative }, stateRoot)
  const validated = validateExecutionArchiveManifest(manifest, expectation)
  validateExecutionArchiveSource(validated, input.sourceBytes)

  const temporary = join(archiveRoot, `.archive-tmp-${randomUUID()}`)
  try {
    await mkdir(temporary)
    await writeExclusiveFile(join(temporary, EXECUTION_ARCHIVE_SOURCE_FILE), input.sourceBytes)
    await writeExclusiveFile(
      join(temporary, EXECUTION_ARCHIVE_MANIFEST_FILE),
      serializeJsonDocument(validated)
    )
    const temporaryCheck = await readArchiveFiles(temporary, expectation, false)
    if (temporaryCheck.manifest.source.sha256 !== input.sourceSha256)
      throw archiveFailure('执行记录归档临时文件校验失败')
    await rename(temporary, directory)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    const raced = await lstatIfExists(directory).catch(() => null)
    if (raced !== null && raced.isDirectory() && !raced.isSymbolicLink()) {
      const archived = await readExecutionRecordArchive(directory, expectation)
      return { directory, manifest: archived.manifest, reused: true }
    }
    if (error instanceof AppException) throw error
    throw mapStorageFailure(error, failure)
  }

  return { directory, manifest: validated, reused: false }
}

export async function restoreExecutionRecordSource(input: {
  readonly stateRoot: string
  readonly projectId: string
  readonly relativePath: string
  readonly archiveDirectory: string
  readonly writtenTargetSha256: string
}): Promise<boolean> {
  const projectId = assertProjectSegment(input.projectId)
  const relativePath = executionRecordRelativePath(projectId)
  if (input.relativePath !== relativePath) throw archiveFailure('执行记录恢复路径与工程不一致')
  let stateRoot: string
  try {
    stateRoot = await realpath(input.stateRoot)
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
  if (!isInside(stateRoot, input.archiveDirectory))
    throw archiveFailure('执行记录归档目录越出状态根')
  await assertNoSymlinkComponents(stateRoot, input.archiveDirectory, '执行记录归档目录')
  const archived = await readExecutionRecordArchive(input.archiveDirectory, {
    projectId,
    relativePath,
    sourceSha256: basename(input.archiveDirectory)
  })
  const target = resolve(stateRoot, ...relativePath.split('/'))
  await assertNoSymlinkComponents(stateRoot, target, '执行记录文件')
  let current: Buffer
  try {
    current = await readFile(target)
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
  if (sha256Hex(current) !== input.writtenTargetSha256) return false
  await writeBytesAtomically(target, archived.sourceBytes)
  let restored: Buffer
  try {
    restored = await readFile(target)
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
  if (sha256Hex(restored) !== archived.manifest.source.sha256)
    throw archiveFailure('执行记录恢复后摘要不一致')
  return true
}

export async function readExecutionRecordDocumentBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw mapStorageFailure(error, failure)
  }
}

export async function executionRecordDocumentModifiedAt(path: string): Promise<string> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
}
