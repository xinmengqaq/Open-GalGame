#!/usr/bin/env node
'use strict'

const { randomUUID } = require('node:crypto')
const { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } = require('node:fs/promises')
const { basename, dirname, isAbsolute, join, resolve } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const { assertNoSymlinkComponents, isInside, realDirectory, samePath } = require('./scope.cjs')

const FORMAT_VERSION = 1
const KIND = 'execution-record-legacy-archive'
const READ_RESPONSIBILITY = 'migration-and-restore-tools-only'
const SOURCE_FILE = 'source.json'
const MANIFEST_FILE = 'manifest.json'
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const EXECUTION_RELATIVE_PATTERN =
  /^scene-generation\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/executions\.json$/
const STATES = new Set([
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
const REASONS = new Set([
  'missing-record-time',
  'current-schema-incomplete',
  'unsupported-envelope-version',
  'unreadable-record'
])
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
]

const USAGE = `执行记录 legacy 归档校验/恢复工具（R29）

用法：
  node scripts/legacy-data-migration/execution-archive.cjs verify --archive-root <绝对路径> [--state-root <绝对路径>]
  node scripts/legacy-data-migration/execution-archive.cjs restore --manifest <绝对路径> --state-root <绝对路径> [--apply]

verify 只读校验 source.json/manifest 的摘要、事实、路径包含与符号链接，支持传入单个归档目录或包含多个归档的目录。
restore 默认 dry-run；--apply 才把 source.json 逐字节恢复回原始 executions.json，不删除归档，也不删除任何原件。
只接受显式绝对路径；归档只服务迁移/恢复工具，不是产品数据源。`

function sha256Hex(bytes) {
  return require('node:crypto').createHash('sha256').update(bytes).digest('hex')
}

function bad(message, details) {
  return new MigrationError(message, { exitCode: 3, details })
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`${label}必须是对象`)
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw bad(`${label}字段不符合执行记录归档格式`)
  }
  return value
}

function assertText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw bad(`${label}必须是非空字符串`)
  return value
}

function assertIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw bad(`${label}必须是 ISO-8601 时间`)
  }
  return value
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw bad(`${label}必须是 64 位小写十六进制摘要`)
  }
  return value
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw bad(`${label}必须是非负整数`)
  return value
}

function assertProjectSegment(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ||
    value === '.' ||
    value === '..' ||
    ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'lpt1', 'lpt2'].includes(value.toLowerCase()) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  ) {
    throw bad(`${label}不是合法工程标识`)
  }
  return value
}

function validateManifest(value, expected = {}) {
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
  if (manifest.formatVersion !== FORMAT_VERSION) throw bad('manifest.formatVersion 不受支持')
  if (manifest.kind !== KIND) throw bad('manifest.kind 不受支持')
  assertText(manifest.toolVersion, 'manifest.toolVersion')
  if (typeof manifest.batchId !== 'string' || !BATCH_ID_PATTERN.test(manifest.batchId)) {
    throw bad('manifest.batchId 格式非法')
  }
  assertIso(manifest.createdAt, 'manifest.createdAt')
  if (manifest.reason !== 'pre-migration-backup') throw bad('manifest.reason 不受支持')

  const source = assertExactKeys(
    manifest.source,
    ['projectId', 'relativePath', 'envelopeVersion', 'sizeBytes', 'sha256', 'modifiedAt'],
    'manifest.source'
  )
  const projectId = assertProjectSegment(source.projectId, 'manifest.source.projectId')
  const relativePath = assertText(source.relativePath, 'manifest.source.relativePath')
  const match = EXECUTION_RELATIVE_PATTERN.exec(relativePath)
  if (!match || match[1] !== projectId) throw bad('manifest.source.relativePath 与工程不一致')
  if (
    !Number.isInteger(source.envelopeVersion) ||
    source.envelopeVersion < 1 ||
    source.envelopeVersion > 7
  ) {
    throw bad('manifest.source.envelopeVersion 不受支持')
  }
  const sizeBytes = assertNonNegativeInteger(source.sizeBytes, 'manifest.source.sizeBytes')
  const sourceSha256 = assertSha256(source.sha256, 'manifest.source.sha256')
  assertIso(source.modifiedAt, 'manifest.source.modifiedAt')

  const target = assertExactKeys(manifest.target, ['envelopeVersion', 'sha256'], 'manifest.target')
  if (target.envelopeVersion !== 7) throw bad('manifest.target.envelopeVersion 必须是 7')
  const targetSha256 = assertSha256(target.sha256, 'manifest.target.sha256')

  const counts = assertExactKeys(manifest.counts, ['total', 'current', 'legacy'], 'manifest.counts')
  const total = assertNonNegativeInteger(counts.total, 'manifest.counts.total')
  const current = assertNonNegativeInteger(counts.current, 'manifest.counts.current')
  const legacyCount = assertNonNegativeInteger(counts.legacy, 'manifest.counts.legacy')
  if (total !== current + legacyCount) throw bad('manifest.counts 不自洽')

  if (!Array.isArray(manifest.legacyRecords)) throw bad('manifest.legacyRecords 必须是数组')
  if (manifest.legacyRecords.length !== legacyCount) {
    throw bad('manifest.legacyRecords 数量与 counts.legacy 不一致')
  }
  const legacyRecords = manifest.legacyRecords.map((item) => {
    const record = assertExactKeys(item, LEGACY_RECORD_KEYS, 'manifest.legacyRecords[]')
    for (const key of [
      'projectId',
      'sceneId',
      'operationId',
      'threadId',
      'branchId',
      'fingerprint'
    ]) {
      assertText(record[key], `manifest.legacyRecords[].${key}`)
    }
    if (record.projectId !== projectId) throw bad('归档记录工程与 manifest 不一致')
    if (!STATES.has(record.state)) throw bad('归档记录 state 不受支持')
    for (const key of ['hasCreatedAt', 'hasUpdatedAt', 'hasTimeline']) {
      if (typeof record[key] !== 'boolean') throw bad(`归档记录 ${key} 必须是布尔值`)
    }
    const rawSha256 = assertSha256(record.rawSha256, 'manifest.legacyRecords[].rawSha256')
    if (!REASONS.has(record.reason)) throw bad('归档记录 reason 不受支持')
    const expectedReason =
      record.hasCreatedAt || record.hasUpdatedAt || record.hasTimeline
        ? 'current-schema-incomplete'
        : 'missing-record-time'
    if (record.reason !== expectedReason) {
      throw bad('归档记录 reason 与已有时间事实不一致')
    }
    return { ...record, rawSha256 }
  })
  const operationIds = new Set()
  for (const record of legacyRecords) {
    if (operationIds.has(record.operationId)) throw bad('归档记录 operationId 重复')
    operationIds.add(record.operationId)
  }

  const coverage = assertExactKeys(
    manifest.coverage,
    ['stateRoot', 'visitedProjects', 'unvisitedProjects'],
    'manifest.coverage'
  )
  if (typeof coverage.stateRoot !== 'string' || !isAbsolute(coverage.stateRoot)) {
    throw bad('manifest.coverage.stateRoot 必须是绝对路径')
  }
  if (!Array.isArray(coverage.visitedProjects) || coverage.visitedProjects.length !== 1) {
    throw bad('manifest.coverage.visitedProjects 必须只登记本次迁移工程')
  }
  if (coverage.visitedProjects[0] !== projectId) {
    throw bad('manifest.coverage.visitedProjects 与工程不一致')
  }
  const unvisited = assertExactKeys(
    coverage.unvisitedProjects,
    ['known', 'count', 'note'],
    'manifest.coverage.unvisitedProjects'
  )
  if (unvisited.known !== false || unvisited.count !== null) {
    throw bad('manifest.coverage.unvisitedProjects 不得声称已知未访问工程')
  }
  assertText(unvisited.note, 'manifest.coverage.unvisitedProjects.note')

  if (manifest.readResponsibility !== READ_RESPONSIBILITY) {
    throw bad('manifest.readResponsibility 必须是工具专用')
  }
  if (manifest.productDataSource !== false) throw bad('manifest.productDataSource 必须为 false')

  if (expected.projectId !== undefined && expected.projectId !== projectId) {
    throw bad('归档工程与预期不一致')
  }
  if (expected.relativePath !== undefined && expected.relativePath !== relativePath) {
    throw bad('归档来源路径与预期不一致')
  }
  if (expected.sourceSha256 !== undefined && expected.sourceSha256 !== sourceSha256) {
    throw bad('归档来源摘要与预期不一致')
  }
  if (expected.targetSha256 !== undefined && expected.targetSha256 !== targetSha256) {
    throw bad('归档目标摘要与预期不一致')
  }
  if (expected.stateRoot !== undefined && !samePath(expected.stateRoot, coverage.stateRoot)) {
    throw bad('归档状态根与预期不一致')
  }
  return {
    projectId,
    relativePath,
    envelopeVersion: source.envelopeVersion,
    sizeBytes,
    sourceSha256,
    modifiedAt: source.modifiedAt,
    targetSha256,
    counts: { total, current, legacy: legacyCount },
    legacyRecords
  }
}

async function regularBytes(path, label) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw bad(`${label}不存在`)
    throw new MigrationError(`${label}无法读取`, { exitCode: 4, details: { cause: error.code } })
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw bad(`${label}不是普通文件`)
  try {
    return await readFile(path)
  } catch (error) {
    throw new MigrationError(`${label}无法读取`, { exitCode: 4, details: { cause: error.code } })
  }
}

function validateSourceBytes(manifest, bytes) {
  if (bytes.byteLength !== manifest.sizeBytes) throw bad('source.json 大小与 manifest 不一致')
  if (sha256Hex(bytes) !== manifest.sourceSha256) throw bad('source.json 摘要与 manifest 不一致')
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw bad(`source.json 不是合法 JSON：${error.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad('source.json 缺少执行记录信封')
  }
  if (value.version !== manifest.envelopeVersion) throw bad('source.json 版本与 manifest 不一致')
  if (!Array.isArray(value.executions) || value.executions.length !== manifest.counts.total) {
    throw bad('source.json 记录数量或结构与 manifest 不一致')
  }
  const records = new Map()
  for (const raw of value.executions) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw bad('source.json 含非对象执行记录')
    }
    if (typeof raw.operationId !== 'string' || records.has(raw.operationId)) {
      throw bad('source.json 执行记录缺少唯一 operationId')
    }
    records.set(raw.operationId, raw)
  }
  for (const entry of manifest.legacyRecords) {
    const raw = records.get(entry.operationId)
    if (!raw) throw bad(`manifest 旧记录不在 source.json：${entry.operationId}`)
    if (raw.projectId !== entry.projectId || raw.sceneId !== entry.sceneId) {
      throw bad(`归档旧记录身份与 source.json 不一致：${entry.operationId}`)
    }
    if (raw.threadId !== entry.threadId || raw.branchId !== entry.branchId) {
      throw bad(`归档旧记录线程/分支与 source.json 不一致：${entry.operationId}`)
    }
    if (raw.fingerprint !== entry.fingerprint || raw.state !== entry.state) {
      throw bad(`归档旧记录指纹/状态与 source.json 不一致：${entry.operationId}`)
    }
    const hasCreatedAt = typeof raw.createdAt === 'string'
    const hasUpdatedAt = typeof raw.updatedAt === 'string'
    const hasTimeline = Array.isArray(raw.timeline) && raw.timeline.length > 0
    if (
      entry.hasCreatedAt !== hasCreatedAt ||
      entry.hasUpdatedAt !== hasUpdatedAt ||
      entry.hasTimeline !== hasTimeline
    ) {
      throw bad(`归档旧记录时间事实与 source.json 不一致：${entry.operationId}`)
    }
    if (sha256Hex(Buffer.from(JSON.stringify(raw), 'utf8')) !== entry.rawSha256) {
      throw bad(`归档旧记录原文摘要与 source.json 不一致：${entry.operationId}`)
    }
  }
}

async function verifyArchive(directory, stateRoot) {
  let stats
  try {
    stats = await lstat(directory)
  } catch (error) {
    throw new MigrationError('归档目录无法检查', { exitCode: 4, details: { cause: error.code } })
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw bad('归档目录不是普通目录')
  if (stateRoot !== null) {
    await assertNoSymlinkComponents(stateRoot, directory, '归档目录')
  } else {
    const parent = dirname(directory)
    if ((await lstat(parent)).isSymbolicLink()) throw bad('归档父目录包含符号链接')
  }

  const manifestBytes = await regularBytes(join(directory, MANIFEST_FILE), '归档 manifest')
  let value
  try {
    value = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw bad(`归档 manifest 不是合法 JSON：${error.message}`)
  }
  const manifest = validateManifest(value, stateRoot === null ? {} : { stateRoot })
  const directoryName = basename(directory)
  if (directoryName !== manifest.sourceSha256) throw bad('归档目录名与来源摘要不一致')
  if (stateRoot !== null) {
    const expected = join(
      stateRoot,
      'scene-generation',
      'projects',
      manifest.projectId,
      'legacy-executions',
      manifest.sourceSha256
    )
    if (!samePath(expected, directory)) throw bad('归档目录不在状态根的固定位置')
    if (!isInside(stateRoot, expected)) throw bad('归档目录越出状态根')
  }
  const sourceBytes = await regularBytes(join(directory, SOURCE_FILE), '归档 source.json')
  validateSourceBytes(manifest, sourceBytes)

  return {
    archiveDirectory: directory,
    projectId: manifest.projectId,
    relativePath: manifest.relativePath,
    envelopeVersion: manifest.envelopeVersion,
    sourceSha256: manifest.sourceSha256,
    sourceSizeBytes: sourceBytes.byteLength,
    targetSha256: manifest.targetSha256,
    counts: manifest.counts,
    legacyRecords: manifest.legacyRecords.length,
    legacyReasons: manifest.legacyRecords.reduce((counts, record) => {
      counts[record.reason] = (counts[record.reason] ?? 0) + 1
      return counts
    }, {}),
    integrity: 'ok'
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new MigrationError('路径无法检查', { exitCode: 4, details: { cause: error.code } })
  }
}

async function listArchives(root) {
  if (await pathExists(join(root, MANIFEST_FILE))) return [root]
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    throw new MigrationError('归档根无法读取', { exitCode: 4, details: { cause: error.code } })
  }
  const directories = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw bad(`归档根包含符号链接：${path}`)
    if (!entry.isDirectory()) continue
    directories.push(path)
  }
  if (directories.length === 0) throw bad('归档根下没有可校验的执行记录归档')
  return directories.sort()
}

async function verifyCommand(options) {
  if (options.apply || options.manifest !== null)
    throw new MigrationError('verify 不接受 --apply/--manifest')
  if (options.archiveRoot === null) throw new MigrationError('verify 需要 --archive-root')
  const archiveRoot = await realDirectory(options.archiveRoot, '归档根')
  const stateRoot =
    options.stateRoot === null ? null : await realDirectory(options.stateRoot, '状态根')
  const archives = await listArchives(archiveRoot)
  const results = []
  const errors = []
  for (const directory of archives) {
    try {
      results.push(await verifyArchive(directory, stateRoot))
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error
      errors.push({
        archiveDirectory: directory,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      })
    }
  }
  if (errors.length > 0) {
    throw new MigrationError('执行记录归档校验失败', { exitCode: 3, details: { errors } })
  }
  return {
    command: 'verify',
    ok: true,
    dryRun: true,
    archiveRoot,
    stateRoot,
    archives: results,
    summary: {
      archives: results.length,
      legacyRecords: results.reduce((sum, item) => sum + item.legacyRecords, 0)
    }
  }
}

async function writeAtomically(target, bytes) {
  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.execution-restore-${randomUUID()}`)
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
      await copyFile(temporary, target)
      await rm(temporary, { force: true })
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function restoreCommand(options) {
  if (options.archiveRoot !== null) throw new MigrationError('restore 不接受 --archive-root')
  if (options.manifest === null) throw new MigrationError('restore 需要 --manifest')
  if (!isAbsolute(options.manifest)) throw new MigrationError('--manifest 必须是绝对路径')
  if (options.stateRoot === null) throw new MigrationError('restore 需要 --state-root')
  const stateRoot = await realDirectory(options.stateRoot, '状态根')
  const manifestPath = resolve(options.manifest)
  if (!isAbsolute(manifestPath)) throw new MigrationError('--manifest 必须是绝对路径')
  if (basename(manifestPath) !== MANIFEST_FILE)
    throw new MigrationError('--manifest 必须指向 manifest.json')
  const archiveDirectory = dirname(manifestPath)
  const manifestStats = await lstat(manifestPath).catch((error) => {
    if (error.code === 'ENOENT') throw bad('归档 manifest 不存在')
    throw new MigrationError('归档 manifest 无法检查', {
      exitCode: 4,
      details: { cause: error.code }
    })
  })
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    throw bad('归档 manifest 不是普通文件')
  }
  const verified = await verifyArchive(archiveDirectory, stateRoot)
  const originalPath = resolve(stateRoot, ...verified.relativePath.split('/'))
  if (!isInside(stateRoot, originalPath)) throw bad('恢复目标越出状态根')
  await assertNoSymlinkComponents(stateRoot, originalPath, '恢复目标')
  let existing = null
  try {
    existing = await lstat(originalPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new MigrationError('恢复目标无法检查', { exitCode: 4, details: { cause: error.code } })
    }
  }
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw bad('恢复目标不是普通文件')
  }
  const currentBytes = existing === null ? null : await regularBytes(originalPath, '恢复目标')
  const plan = {
    archiveDirectory,
    manifestPath,
    projectId: verified.projectId,
    relativePath: verified.relativePath,
    originalPath,
    sourceSha256: verified.sourceSha256,
    sourceSizeBytes: verified.sourceSizeBytes,
    targetSha256: verified.targetSha256,
    current:
      currentBytes === null
        ? {
            exists: false,
            sizeBytes: 0,
            sha256: null,
            matchesSource: false,
            matchesMigratedTarget: false
          }
        : {
            exists: true,
            sizeBytes: currentBytes.byteLength,
            sha256: sha256Hex(currentBytes),
            matchesSource: sha256Hex(currentBytes) === verified.sourceSha256,
            matchesMigratedTarget: sha256Hex(currentBytes) === verified.targetSha256
          }
  }
  if (!options.apply) {
    return { command: 'restore', ok: true, dryRun: true, stateRoot, ...plan }
  }
  const sourceBytes = await regularBytes(join(archiveDirectory, SOURCE_FILE), '归档 source.json')
  if (
    sourceBytes.byteLength !== verified.sourceSizeBytes ||
    sha256Hex(sourceBytes) !== verified.sourceSha256
  ) {
    throw bad('恢复前 source.json 复核失败')
  }
  await assertNoSymlinkComponents(stateRoot, originalPath, '恢复目标')
  await writeAtomically(originalPath, sourceBytes)
  const restoredBytes = await readFile(originalPath)
  if (sha256Hex(restoredBytes) !== verified.sourceSha256) {
    throw new MigrationError('恢复后摘要不一致', { exitCode: 4 })
  }
  return {
    command: 'restore',
    ok: true,
    dryRun: false,
    stateRoot,
    ...plan,
    restored: {
      originalPath,
      sizeBytes: restoredBytes.byteLength,
      sha256: sha256Hex(restoredBytes)
    }
  }
}

function parseArgs(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') return { command: 'help' }
  const options = {
    apply: false,
    archiveRoot: null,
    stateRoot: null,
    manifest: null
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') {
      options.apply = true
      continue
    }
    if (token === '--help' || token === '-h') return { command: 'help' }
    const equal = token.indexOf('=')
    const name = equal === -1 ? token : token.slice(0, equal)
    const value = equal === -1 ? argv[index + 1] : token.slice(equal + 1)
    if (equal === -1) {
      if (value === undefined || value.startsWith('--')) {
        throw new MigrationError(`选项缺少值：${name}`)
      }
      index += 1
    }
    if (!isAbsolute(value)) throw new MigrationError(`${name} 必须是绝对路径`)
    if (name === '--archive-root') options.archiveRoot = value
    else if (name === '--state-root') options.stateRoot = value
    else if (name === '--manifest') options.manifest = value
    else throw new MigrationError(`未知选项：${name}`)
  }
  return { command, options }
}

async function run(argv) {
  const { command, options } = parseArgs(argv)
  if (command === 'help') return null
  if (command === 'verify') return verifyCommand(options)
  if (command === 'restore') return restoreCommand(options)
  throw new MigrationError(`未知命令：${String(command)}`)
}

async function main() {
  const command = process.argv[2] ?? null
  try {
    const result = await run(process.argv.slice(2))
    if (result === null) {
      process.stdout.write(`${USAGE}\n`)
      return
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    const exitCode = error instanceof MigrationError ? error.exitCode : 4
    const payload = {
      ok: false,
      command,
      code: exitCode,
      error: error instanceof Error ? error.message : String(error)
    }
    if (error instanceof MigrationError && error.details !== undefined)
      payload.details = error.details
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (error instanceof Error) process.stderr.write(`${error.message}\n`)
    process.exitCode = exitCode
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  FORMAT_VERSION,
  KIND,
  READ_RESPONSIBILITY,
  validateManifest,
  verifyArchive
}
