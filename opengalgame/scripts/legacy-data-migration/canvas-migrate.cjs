#!/usr/bin/env node
'use strict'

const { randomUUID } = require('node:crypto')
const {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} = require('node:fs/promises')
const { basename, dirname, isAbsolute, join, resolve } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const { UNVISITED_NOTE } = require('./inventory.cjs')
const {
  createManifest,
  isoNow,
  readManifest,
  sha256,
  writeManifestAtomic
} = require('./manifest.cjs')
const { loadReader } = require('./reader-loader.cjs')
const { assertNoSymlinkComponents, isInside, realDirectory } = require('./scope.cjs')

const USAGE = `画布旧格式迁移工具（R28，复用 R27 manifest v1）

用法：
  node scripts/legacy-data-migration/canvas-migrate.cjs --project-root <绝对路径> [--backup-root <绝对路径>] [--apply]

默认 dry-run：只报告 v3/v4 将如何迁移，不写来源、不生成备份。
--apply 需要 --backup-root；备份先于原子写，批次可由 R27 cli.cjs verify/restore 消费。
只处理显式传入的工程；不自动扫描用户目录；不删除原件；不接产品运行时。`

const BATCH_DIGEST_LABEL = 'canvas-arrangement-migration-v1'
const REPORT_TOOL_VERSION = 'scene-canvas-1'
const TARGET_VERSION = 5
const TEMPORARY_PREFIX = '.opengalgame-tmp-'

function parseArgs(argv) {
  const options = { apply: false, projectRoot: null, backupRoot: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') {
      options.apply = true
      continue
    }
    if (token === '--help' || token === '-h') return { help: true, options }
    const equal = token.indexOf('=')
    const name = equal === -1 ? token : token.slice(0, equal)
    const value = equal === -1 ? argv[index + 1] : token.slice(equal + 1)
    if (equal === -1) {
      if (value === undefined || value.startsWith('--')) {
        throw new MigrationError(`选项缺少值：${name}`)
      }
      index += 1
    }
    if (name === '--project-root') options.projectRoot = value
    else if (name === '--backup-root') options.backupRoot = value
    else throw new MigrationError(`未知选项：${name}`)
  }
  return { help: false, options }
}

function compareName(left, right) {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

async function readOptionalDirectory(path, label) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new MigrationError(`${label}无法访问：${path}`, {
      exitCode: 4,
      details: { cause: error.code }
    })
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new MigrationError(`${label}包含符号链接，拒绝越出显式根：${join(path, entry.name)}`)
    }
  }
  return entries.sort(compareName)
}

async function readProjectId(projectRoot) {
  const path = join(projectRoot, '.opengalgame', 'manifest.json')
  await assertNoSymlinkComponents(projectRoot, path, '工程身份文件')
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new MigrationError(`工程身份文件无法读取：${path}`, {
      exitCode: 4,
      details: { cause: error.code ?? error.message }
    })
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.projectId !== 'string' ||
    value.projectId === ''
  ) {
    throw new MigrationError(`工程身份文件缺少 projectId：${path}`, { exitCode: 3 })
  }
  return value.projectId
}

async function canvasTargets(projectRoot) {
  const root = join(projectRoot, '.opengalgame', 'canvases')
  if (!isInside(projectRoot, root)) {
    throw new MigrationError('画布目录越出工程根')
  }
  const targets = []
  for (const scene of await readOptionalDirectory(root, '画布目录')) {
    if (!scene.isDirectory() || scene.name.startsWith(TEMPORARY_PREFIX)) continue
    const sceneDirectory = join(root, scene.name)
    for (const file of await readOptionalDirectory(sceneDirectory, '画布场景目录')) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      if (file.name.startsWith(TEMPORARY_PREFIX)) continue
      targets.push({
        relativePath: `.opengalgame/canvases/${scene.name}/${file.name}`,
        sceneKey: scene.name,
        canvasKey: file.name.slice(0, -'.json'.length),
        path: join(sceneDirectory, file.name)
      })
    }
  }
  return targets
}

function parseDocument(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function plannedOutcome(reader, document, projectId, sceneId, canvasId, digest) {
  const plan = reader.planCanvasArrangementMigration(
    document,
    { projectId, sceneId, canvasId },
    digest
  )
  if (!plan.ok) {
    return {
      status: plan.reason === 'current' ? 'current' : 'skipped',
      reason: plan.reason,
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  return {
    status: 'would-migrate',
    sourceVersion: plan.sourceVersion,
    targetVersion: TARGET_VERSION,
    preserved: plan.preserved,
    defaulted: plan.defaulted,
    normalized: plan.normalized,
    unsupported: plan.unsupported
  }
}

async function inspectTarget(reader, projectId, target) {
  const sceneId = reader.decodeStorageKey(target.sceneKey)
  const canvasId = reader.decodeStorageKey(target.canvasKey)
  const base = { relativePath: target.relativePath }
  if (sceneId === null || canvasId === null) {
    return { ...base, status: 'skipped', reason: 'identity' }
  }
  const bytes = await readFile(target.path)
  const parsed = parseDocument(bytes)
  if (!parsed.ok) {
    return { ...base, sceneId, canvasId, status: 'skipped', reason: 'damaged' }
  }
  return {
    ...base,
    sceneId,
    canvasId,
    ...plannedOutcome(reader, parsed.value, projectId, sceneId, canvasId, sha256(bytes))
  }
}

function batchIdFor(projectRoot, relativePath, sourceDigest) {
  return sha256(JSON.stringify([BATCH_DIGEST_LABEL, projectRoot, relativePath, sourceDigest]))
}

function scopeFor(projectRoot) {
  return {
    stateRoot: null,
    projectRoots: [projectRoot],
    visitedProjects: [projectRoot],
    unvisitedProjects: {
      known: false,
      count: null,
      note: UNVISITED_NOTE
    }
  }
}

async function realPathOfPossiblyMissing(target) {
  if (!isAbsolute(target)) throw new MigrationError(`必须是绝对路径：${target}`, { exitCode: 2 })
  const missing = []
  let current = resolve(target)
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

async function resolveInsideRealRoot(rootReal, relativePosix) {
  if (
    typeof relativePosix !== 'string' ||
    relativePosix.length === 0 ||
    relativePosix.includes('\0') ||
    relativePosix.includes('\\') ||
    relativePosix.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePosix)
  ) {
    throw new MigrationError(`非法备份相对路径：${String(relativePosix)}`, { exitCode: 3 })
  }
  const parts = relativePosix.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new MigrationError(`非法备份相对路径：${relativePosix}`, { exitCode: 3 })
  }
  let current = rootReal
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index])
    let stats
    try {
      stats = await lstat(next)
    } catch (error) {
      if (error.code === 'ENOENT') return join(current, ...parts.slice(index))
      throw error
    }
    if (stats.isSymbolicLink()) {
      const real = await realpath(next)
      if (!isInside(rootReal, real)) {
        throw new MigrationError(`备份路径经链接越出备份根：${next} -> ${real}`, { exitCode: 3 })
      }
      current = real
    } else {
      current = next
    }
  }
  if (!isInside(rootReal, current)) {
    throw new MigrationError(`备份路径越出备份根：${relativePosix}`, { exitCode: 3 })
  }
  return current
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function writeBytesAtomically(target, bytes) {
  const temporary = join(dirname(target), `${TEMPORARY_PREFIX}${randomUUID()}`)
  const handle = await open(temporary, 'wx')
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeJsonAtomically(target, value) {
  const temporary = join(dirname(target), `${TEMPORARY_PREFIX}${randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      flush: true
    })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function reuseBatch({ batchDir, batchId, backupPath, originalPath, bytes, digest }) {
  const manifestPath = await resolveInsideRealRoot(batchDir, 'manifest.json')
  const manifest = await readManifest(manifestPath)
  if (manifest.batchId !== batchId) {
    throw new MigrationError(`已存在批次标识不一致：${batchDir}`, { exitCode: 3 })
  }
  if (resolve(manifest.backupRoot) !== resolve(batchDir)) {
    throw new MigrationError(`已存在批次备份根不一致：${batchDir}`, { exitCode: 3 })
  }
  const entry = manifest.entries.find(
    (item) => resolve(item.originalPath) === resolve(originalPath)
  )
  if (
    entry === undefined ||
    entry.backupPath !== backupPath ||
    entry.sizeBytes !== bytes.byteLength ||
    entry.sha256 !== digest
  ) {
    throw new MigrationError(`同批次备份条目与当前来源不一致，拒绝覆盖：${batchDir}`, {
      exitCode: 3
    })
  }
  const backupBytes = await readFile(await resolveInsideRealRoot(batchDir, backupPath))
  if (sha256(backupBytes) !== digest) {
    throw new MigrationError(`同批次备份字节与 manifest 不一致：${batchDir}`, { exitCode: 3 })
  }
  return manifest
}

async function reserveBatch({
  backupRoot,
  projectRoot,
  relativePath,
  originalPath,
  bytes,
  digest,
  createdAt
}) {
  const batchId = batchIdFor(projectRoot, relativePath, digest)
  const batchDir = await resolveInsideRealRoot(backupRoot, batchId)
  const backupPath = `files/project-0/${relativePath}`
  if (await exists(batchDir)) {
    await reuseBatch({ batchDir, batchId, backupPath, originalPath, bytes, digest })
    return { batchId, directory: batchDir, backupPath }
  }
  await mkdir(backupRoot, { recursive: true })
  const staging = join(backupRoot, `.staging-${batchId}-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  let stagingReal
  try {
    stagingReal = await realpath(staging)
    if (!isInside(backupRoot, stagingReal)) {
      throw new MigrationError('暂存目录经链接越出备份根', { exitCode: 3 })
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  try {
    const stagingBackup = await resolveInsideRealRoot(stagingReal, backupPath)
    await mkdir(dirname(stagingBackup), { recursive: true })
    await writeFile(stagingBackup, bytes, { flag: 'wx', flush: true })
    if (sha256(await readFile(stagingBackup)) !== digest) {
      throw new MigrationError('备份摘要校验失败', { exitCode: 3 })
    }
    const stats = await lstat(originalPath)
    const manifest = createManifest({
      batchId,
      scope: scopeFor(projectRoot),
      backupRoot: batchDir,
      createdAt,
      entries: [
        {
          family: 'canvas',
          originalPath,
          backupPath,
          sizeBytes: bytes.byteLength,
          sha256: digest,
          modifiedAt: stats.mtime.toISOString(),
          backedUpAt: createdAt
        }
      ]
    })
    await writeManifestAtomic(join(stagingReal, 'manifest.json'), manifest)
    await rename(stagingReal, batchDir)
    return { batchId, directory: batchDir, backupPath }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await rm(stagingReal, { recursive: true, force: true }).catch(() => undefined)
    if (await exists(batchDir)) {
      await reuseBatch({ batchDir, batchId, backupPath, originalPath, bytes, digest })
      return { batchId, directory: batchDir, backupPath }
    }
    throw error
  }
}

async function verifyWritten(target, document, writtenDigest) {
  try {
    const bytes = await readFile(target)
    if (sha256(bytes) !== writtenDigest) return '写后摘要不一致'
    const parsed = parseDocument(bytes)
    if (!parsed.ok) return '写后内容无法解析'
    if (JSON.stringify(parsed.value) !== JSON.stringify(document)) return '写后字段与规划不一致'
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function recoverOwnWrite(target, backupFile, writtenDigest, sourceDigest) {
  let current
  try {
    current = await readFile(target)
  } catch {
    return false
  }
  if (sha256(current) !== writtenDigest) return false
  let backup
  try {
    backup = await readFile(backupFile)
  } catch {
    return false
  }
  if (sha256(backup) !== sourceDigest) return false
  try {
    await writeBytesAtomically(target, backup)
    return sha256(await readFile(target)) === sourceDigest
  } catch {
    return false
  }
}

async function migrateTarget(reader, projectRoot, projectId, backupRoot, target) {
  const sceneId = reader.decodeStorageKey(target.sceneKey)
  const canvasId = reader.decodeStorageKey(target.canvasKey)
  const base = { relativePath: target.relativePath }
  if (sceneId === null || canvasId === null) {
    return { ...base, status: 'skipped', reason: 'identity' }
  }
  let bytes
  try {
    bytes = await readFile(target.path)
  } catch (error) {
    return {
      ...base,
      sceneId,
      canvasId,
      status: 'failed',
      sourceVersion: null,
      targetVersion: TARGET_VERSION,
      failure: { stage: 'resolve', code: error.code },
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  const digest = sha256(bytes)
  const parsed = parseDocument(bytes)
  if (!parsed.ok) {
    return { ...base, sceneId, canvasId, status: 'skipped', reason: 'damaged' }
  }
  const plan = reader.planCanvasArrangementMigration(
    parsed.value,
    { projectId, sceneId, canvasId },
    digest
  )
  if (!plan.ok) {
    return {
      ...base,
      sceneId,
      canvasId,
      status: plan.reason === 'current' ? 'current' : 'skipped',
      reason: plan.reason,
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  const createdAt = isoNow()
  let batch
  try {
    batch = await reserveBatch({
      backupRoot,
      projectRoot,
      relativePath: target.relativePath,
      originalPath: target.path,
      bytes,
      digest,
      createdAt
    })
  } catch (error) {
    return {
      ...base,
      sceneId,
      canvasId,
      status: 'failed',
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      failure: { stage: 'backup', message: error.message },
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  let current
  try {
    current = await readFile(target.path)
  } catch {
    current = null
  }
  if (current === null || sha256(current) !== digest) {
    return {
      ...base,
      sceneId,
      canvasId,
      status: 'skipped',
      reason: 'changed',
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      batchId: batch.batchId,
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  const written = Buffer.from(JSON.stringify(plan.document), 'utf8')
  const writtenDigest = sha256(written)
  try {
    await writeBytesAtomically(target.path, written)
  } catch (error) {
    return {
      ...base,
      sceneId,
      canvasId,
      status: 'failed',
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      batchId: batch.batchId,
      failure: { stage: 'write', message: error.message },
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  const verification = await verifyWritten(target.path, plan.document, writtenDigest)
  if (verification !== null) {
    const recovered = await recoverOwnWrite(
      target.path,
      join(batch.directory, ...batch.backupPath.split('/')),
      writtenDigest,
      digest
    )
    return {
      ...base,
      sceneId,
      canvasId,
      status: 'failed',
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      batchId: batch.batchId,
      failure: { stage: 'verify', message: verification },
      recovered,
      preserved: [],
      defaulted: [],
      normalized: [],
      unsupported: []
    }
  }
  let reportPath = null
  try {
    const writtenReport = join(batch.directory, 'report.json')
    await writeJsonAtomically(writtenReport, {
      formatVersion: 1,
      kind: 'canvas-arrangement-migration-report',
      batchId: batch.batchId,
      toolVersion: REPORT_TOOL_VERSION,
      createdAt: isoNow(),
      trigger: 'cli',
      projectId,
      sceneId,
      canvasId,
      sourceVersion: plan.sourceVersion,
      targetVersion: TARGET_VERSION,
      sourceSha256: digest,
      writtenSha256: writtenDigest,
      preserved: plan.preserved,
      defaulted: plan.defaulted,
      normalized: plan.normalized,
      unsupported: plan.unsupported
    })
    reportPath = writtenReport
  } catch {
  }
  return {
    ...base,
    sceneId,
    canvasId,
    status: 'migrated',
    sourceVersion: plan.sourceVersion,
    targetVersion: TARGET_VERSION,
    batchId: batch.batchId,
    manifestPath: join(batch.directory, 'manifest.json'),
    reportPath,
    preserved: plan.preserved,
    defaulted: plan.defaulted,
    normalized: plan.normalized,
    unsupported: plan.unsupported
  }
}

function summarize(files) {
  return {
    total: files.length,
    migrated: files.filter((file) => file.status === 'migrated').length,
    wouldMigrate: files.filter((file) => file.status === 'would-migrate').length,
    current: files.filter((file) => file.status === 'current').length,
    skipped: files.filter((file) => file.status === 'skipped').length,
    failed: files.filter((file) => file.status === 'failed').length
  }
}

async function run(argv) {
  const { help, options } = parseArgs(argv)
  if (help) {
    process.stdout.write(`${USAGE}\n`)
    return null
  }
  if (options.projectRoot === null) {
    throw new MigrationError('canvas-migrate 需要 --project-root')
  }
  const projectRoot = await realDirectory(options.projectRoot, '工程根')
  let backupRoot = null
  if (options.backupRoot !== null) {
    try {
      backupRoot = await realPathOfPossiblyMissing(resolve(options.backupRoot))
    } catch (error) {
      throw new MigrationError(
        `备份根无法解析：${error instanceof Error ? error.message : String(error)}`,
        { exitCode: 4 }
      )
    }
    if (isInside(projectRoot, backupRoot) || isInside(backupRoot, projectRoot)) {
      throw new MigrationError('备份根真实路径不能位于工程根内或包含工程根', { exitCode: 2 })
    }
  } else if (options.apply) {
    throw new MigrationError('canvas-migrate --apply 需要 --backup-root')
  }
  const projectId = await readProjectId(projectRoot)
  const reader = await loadReader()
  const targets = await canvasTargets(projectRoot)
  const files = []
  for (const target of targets) {
    files.push(
      options.apply
        ? await migrateTarget(reader, projectRoot, projectId, backupRoot, target)
        : await inspectTarget(reader, projectId, target)
    )
  }
  const summary = summarize(files)
  return {
    command: 'canvas-migrate',
    ok: summary.failed === 0,
    dryRun: !options.apply,
    backupRoot,
    scope: scopeFor(projectRoot),
    files,
    summary
  }
}

async function main() {
  try {
    const result = await run(process.argv.slice(2))
    if (result === null) return
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 3
  } catch (error) {
    const exitCode = error instanceof MigrationError ? error.exitCode : 4
    const payload = {
      ok: false,
      command: 'canvas-migrate',
      code: exitCode,
      error: error instanceof Error ? error.message : String(error)
    }
    if (error instanceof MigrationError && error.details !== undefined) {
      payload.details = error.details
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (error instanceof Error) process.stderr.write(`${error.message}\n`)
    process.exitCode = exitCode
  }
}

main()
