'use strict'

const { createHash, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const {
  assertRootsDisjoint,
  isInside,
  pathKey,
  safeRelativePosix,
  scopeRoots
} = require('./scope.cjs')

const MANIFEST_FORMAT_VERSION = 1
const TOOL_VERSION = '1'
const BATCH_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const FAMILIES = new Set(['canvas', 'execution', 'operation'])
const CANVAS_RELATIVE_PATTERN = /^\.opengalgame\/canvases\/([0-9a-f]+)\/([0-9a-f]+)\.json$/
const EXECUTION_RELATIVE_PATTERN = /^scene-generation\/projects\/([^/\\]+)\/executions\.json$/
const OPERATION_RELATIVE_PATTERN = /^\.git\/opengalgame\/operations\/([\w-]{1,128})\.json$/

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function newBatchId() {
  return randomUUID()
}

function isoNow() {
  return new Date().toISOString()
}

function assertBatchId(batchId) {
  if (
    typeof batchId !== 'string' ||
    !BATCH_ID_PATTERN.test(batchId) ||
    batchId === '.' ||
    batchId === '..'
  ) {
    throw new MigrationError('batchId 必须是 1–128 位字母、数字、点、下划线或连字符，且不能是 . 或 ..')
  }
  return batchId
}

function assertIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new MigrationError(`${label}必须是 ISO-8601 时间`)
  }
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MigrationError(`${label}必须是对象`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new MigrationError(`${label}包含未知字段：${key}`)
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new MigrationError(`${label}缺少字段：${key}`)
  }
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new MigrationError(`${label}必须是绝对路径`)
  }
}

function assertScope(scope) {
  assertExactKeys(
    scope,
    new Set(['stateRoot', 'projectRoots', 'visitedProjects', 'unvisitedProjects']),
    'manifest.scope'
  )
  if (scope.stateRoot !== null) assertAbsolute(scope.stateRoot, 'manifest.scope.stateRoot')
  if (!Array.isArray(scope.projectRoots)) {
    throw new MigrationError('manifest.scope.projectRoots 必须是数组')
  }
  for (const root of scope.projectRoots) assertAbsolute(root, 'manifest.scope.projectRoots[]')
  if (!Array.isArray(scope.visitedProjects)) {
    throw new MigrationError('manifest.scope.visitedProjects 必须是数组')
  }
  for (const root of scope.visitedProjects) {
    assertAbsolute(root, 'manifest.scope.visitedProjects[]')
  }
  assertExactKeys(
    scope.unvisitedProjects,
    new Set(['known', 'count', 'note']),
    'manifest.scope.unvisitedProjects'
  )
  if (typeof scope.unvisitedProjects.known !== 'boolean') {
    throw new MigrationError('manifest.scope.unvisitedProjects.known 必须是布尔值')
  }
  if (scope.unvisitedProjects.count !== null && !Number.isInteger(scope.unvisitedProjects.count)) {
    throw new MigrationError('manifest.scope.unvisitedProjects.count 必须是整数或 null')
  }
  if (typeof scope.unvisitedProjects.note !== 'string' || scope.unvisitedProjects.note.length === 0) {
    throw new MigrationError('manifest.scope.unvisitedProjects.note 必须是非空说明')
  }
  assertRootsDisjoint(scopeRoots(scope))
}

function toPosixPath(value) {
  return value.split(sep).join('/')
}

function assertFamilyPathAndNamespace(entry, scope) {
  const originalPath = resolve(entry.originalPath)
  const expected = (() => {
    if (entry.family === 'execution') {
      if (scope.stateRoot === null) {
        throw new MigrationError('execution 条目要求 manifest.scope.stateRoot')
      }
      const relativePath = toPosixPath(relative(scope.stateRoot, originalPath))
      if (!EXECUTION_RELATIVE_PATTERN.test(relativePath)) {
        throw new MigrationError(`execution 原路径不是真实执行记录位置：${entry.originalPath}`)
      }
      return `files/state/${relativePath}`
    }
    for (let index = 0; index < scope.projectRoots.length; index += 1) {
      const root = scope.projectRoots[index]
      if (!isInside(root, originalPath)) continue
      const relativePath = toPosixPath(relative(root, originalPath))
      const pattern =
        entry.family === 'canvas' ? CANVAS_RELATIVE_PATTERN : OPERATION_RELATIVE_PATTERN
      const match = pattern.exec(relativePath)
      if (!match) continue
      if (
        entry.family === 'canvas' &&
        (match[1].length < 2 ||
          match[1].length > 250 ||
          match[1].length % 2 !== 0 ||
          match[2].length < 2 ||
          match[2].length > 250 ||
          match[2].length % 2 !== 0)
      ) {
        continue
      }
      return `files/project-${index}/${relativePath}`
    }
    throw new MigrationError(
      `${entry.family} 原路径不是该族的真实位置：${entry.originalPath}`
    )
  })()
  if (entry.backupPath !== expected) {
    throw new MigrationError(
      `manifest 备份路径与 family/源根不一致：${entry.backupPath}，期望 ${expected}`
    )
  }
}

function assertManifestEntry(entry, manifestRoots) {
  assertExactKeys(
    entry,
    new Set([
      'family',
      'originalPath',
      'backupPath',
      'sizeBytes',
      'sha256',
      'modifiedAt',
      'backedUpAt'
    ]),
    'manifest.entries[]'
  )
  if (!FAMILIES.has(entry.family)) {
    throw new MigrationError(`manifest 条目 family 非法：${String(entry.family)}`)
  }
  assertAbsolute(entry.originalPath, 'manifest.entries[].originalPath')
  if (!manifestRoots.some((root) => isInside(root, entry.originalPath))) {
    throw new MigrationError(`manifest 条目原路径不在 scope 根内：${entry.originalPath}`)
  }
  safeRelativePosix(entry.backupPath, 'manifest.entries[].backupPath')
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw new MigrationError('manifest.entries[].sizeBytes 必须是非负整数')
  }
  if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
    throw new MigrationError('manifest.entries[].sha256 必须是 64 位小写十六进制')
  }
  assertIso(entry.modifiedAt, 'manifest.entries[].modifiedAt')
  assertIso(entry.backedUpAt, 'manifest.entries[].backedUpAt')
}

function assertManifest(value) {
  assertExactKeys(
    value,
    new Set([
      'formatVersion',
      'kind',
      'batchId',
      'toolVersion',
      'createdAt',
      'backupRoot',
      'scope',
      'entries'
    ]),
    'manifest'
  )
  if (value.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new MigrationError(`manifest.formatVersion 必须是 ${MANIFEST_FORMAT_VERSION}`)
  }
  if (value.kind !== 'legacy-data-backup') {
    throw new MigrationError('manifest.kind 必须是 legacy-data-backup')
  }
  if (typeof value.batchId !== 'string' || !BATCH_ID_PATTERN.test(value.batchId)) {
    throw new MigrationError('manifest.batchId 格式非法')
  }
  assertBatchId(value.batchId)
  if (typeof value.toolVersion !== 'string' || value.toolVersion.length === 0) {
    throw new MigrationError('manifest.toolVersion 必须是非空字符串')
  }
  assertIso(value.createdAt, 'manifest.createdAt')
  assertAbsolute(value.backupRoot, 'manifest.backupRoot')
  assertScope(value.scope)
  if (!Array.isArray(value.entries)) throw new MigrationError('manifest.entries 必须是数组')
  const manifestRoots = scopeRoots(value.scope)
  if (manifestRoots.length === 0) throw new MigrationError('manifest.scope 至少需要一个显式根')

  const originals = new Set()
  const backups = new Set()
  for (const entry of value.entries) {
    assertManifestEntry(entry, manifestRoots)
    assertFamilyPathAndNamespace(entry, value.scope)
    const originalKey = pathKey(resolve(entry.originalPath))
    const backupKey = pathKey(entry.backupPath)
    if (originals.has(originalKey)) {
      throw new MigrationError(`manifest 原路径规范化后重复：${entry.originalPath}`)
    }
    if (backups.has(backupKey)) {
      throw new MigrationError(`manifest 备份路径重复：${entry.backupPath}`)
    }
    originals.add(originalKey)
    backups.add(backupKey)
  }
  return value
}

function createManifest({ batchId = newBatchId(), scope, backupRoot, entries, createdAt = isoNow() }) {
  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    kind: 'legacy-data-backup',
    batchId,
    toolVersion: TOOL_VERSION,
    createdAt,
    backupRoot,
    scope,
    entries
  }
  return assertManifest(manifest)
}

async function readManifest(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new MigrationError(`manifest 无法读取：${path}`, {
      exitCode: 4,
      details: { cause: error.code }
    })
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new MigrationError(`manifest 不是合法 JSON：${path}`, {
      exitCode: 3,
      details: { cause: error.message }
    })
  }
  try {
    return assertManifest(value)
  } catch (error) {
    if (error instanceof MigrationError) error.exitCode = 3
    throw error
  }
}

async function writeManifestAtomic(path, manifest) {
  assertManifest(manifest)
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.manifest-tmp-${randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw new MigrationError(`manifest 写入失败：${path}`, {
      exitCode: 4,
      details: { cause: error.code ?? error.message }
    })
  }
}

module.exports = {
  BATCH_ID_PATTERN,
  FAMILIES,
  MANIFEST_FORMAT_VERSION,
  SHA256_PATTERN,
  TOOL_VERSION,
  assertBatchId,
  assertFamilyPathAndNamespace,
  assertManifest,
  assertManifestEntry,
  createManifest,
  isoNow,
  newBatchId,
  readManifest,
  sha256,
  writeManifestAtomic
}
