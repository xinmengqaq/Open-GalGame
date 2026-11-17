'use strict'

const { lstat, readFile } = require('node:fs/promises')
const { join, relative, sep } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const { classifyFile } = require('./formats.cjs')
const { isoNow, readManifest, sha256 } = require('./manifest.cjs')
const { assertNoSymlinkComponents, isInside, realDirectory, resolveInside } = require('./scope.cjs')

function posixRelative(root, target) {
  return relative(root, target).split(sep).join('/')
}

async function projectIdFor(root, cache) {
  if (cache.has(root)) return cache.get(root)
  let projectId = null
  try {
    const path = join(root, '.opengalgame', 'manifest.json')
    await assertNoSymlinkComponents(root, path, '工程身份文件')
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value !== null && typeof value === 'object' && typeof value.projectId === 'string') {
      projectId = value.projectId
    }
  } catch {
    projectId = null
  }
  cache.set(root, projectId)
  return projectId
}

async function readerContext(entry, manifest, projectIds) {
  if (entry.family === 'execution') {
    if (manifest.scope.stateRoot === null) return null
    const match = /^scene-generation\/projects\/([^/\\]+)\/executions\.json$/.exec(
      posixRelative(manifest.scope.stateRoot, entry.originalPath)
    )
    return match ? { projectId: match[1] } : null
  }
  for (const root of manifest.scope.projectRoots) {
    if (!isInside(root, entry.originalPath)) continue
    const relativePath = posixRelative(root, entry.originalPath)
    if (entry.family === 'canvas') {
      const match = /^\.opengalgame\/canvases\/([^/]+)\/([^/]+)\.json$/.exec(relativePath)
      if (!match) continue
      return {
        identity: {
          projectId: await projectIdFor(root, projectIds),
          sceneKey: match[1],
          canvasKey: match[2]
        }
      }
    }
    const match = /^\.git\/opengalgame\/operations\/([^/]+)\.json$/.exec(relativePath)
    if (match) return { operationId: match[1] }
  }
  return null
}

async function verify({ manifestPath, backupRoot: backupRootOverride = null, allowUnreadable = false }) {
  const manifest = await readManifest(manifestPath)
  const projectIds = new Map()
  const backupRoot = await realDirectory(
    backupRootOverride ?? manifest.backupRoot,
    '备份根'
  )
  const entries = []
  const errors = []
  for (const entry of manifest.entries) {
    const result = {
      family: entry.family,
      originalPath: entry.originalPath,
      backupPath: entry.backupPath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      modifiedAt: entry.modifiedAt,
      backedUpAt: entry.backedUpAt,
      integrity: 'ok',
      classification: null,
      formatVersion: null
    }
    try {
      const path = await resolveInside(backupRoot, entry.backupPath, '备份文件')
      const stats = await lstat(path)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new MigrationError(`备份文件不是普通文件：${entry.backupPath}`, { exitCode: 3 })
      }
      if (stats.size !== entry.sizeBytes) {
        throw new MigrationError(`备份大小不一致：${entry.backupPath}`, { exitCode: 3 })
      }
      const bytes = await readFile(path)
      if (sha256(bytes) !== entry.sha256) {
        throw new MigrationError(`备份摘要不一致：${entry.backupPath}`, { exitCode: 3 })
      }
      const context = await readerContext(entry, manifest, projectIds)
      const classified = context
        ? await classifyFile(bytes, entry.family, context)
        : {
            classification: 'unreadable',
            formatVersion: null,
            error: '备份条目的源路径无法解析 reader 身份上下文'
          }
      result.classification = classified.classification
      result.formatVersion = classified.formatVersion ?? null
      if (classified.details) result.details = classified.details
      if (classified.records) result.records = classified.records
      if (classified.operationId) result.operationId = classified.operationId
      if (classified.rollbackIndex) result.rollbackIndex = classified.rollbackIndex
      if (classified.error) result.warning = classified.error
    } catch (error) {
      result.integrity = 'failed'
      result.error = error instanceof MigrationError ? error.message : String(error)
      errors.push({ backupPath: entry.backupPath, message: result.error })
    }
    entries.push(result)
  }

  if (errors.length > 0) {
    throw new MigrationError('备份校验失败，未进行任何写入', {
      exitCode: 3,
      details: { errors }
    })
  }

  const warnings = entries.filter((entry) => entry.warning)
  const unreadable = entries.filter((entry) => entry.classification === 'unreadable')
  if (unreadable.length > 0 && !allowUnreadable) {
    throw new MigrationError(
      '备份含不可读数据；verify 不能判为可读通过，仅可显式 --allow-unreadable 做字节完整性验收',
      {
        exitCode: 3,
        details: {
          unreadable: unreadable.map((entry) => ({
            family: entry.family,
            originalPath: entry.originalPath,
            warning: entry.warning
          }))
        }
      }
    )
  }
  const readable = unreadable.length === 0
  return {
    command: 'verify',
    ok: true,
    integrityOk: true,
    formatOk: readable,
    readable,
    bytesOnly: !readable,
    contract: readable ? 'schema-readback' : 'bytes-only',
    dryRun: true,
    checkedAt: isoNow(),
    manifestPath,
    batchId: manifest.batchId,
    toolVersion: manifest.toolVersion,
    backupRoot,
    scope: manifest.scope,
    entries,
    warnings: warnings.map((entry) => ({
      backupPath: entry.backupPath,
      originalPath: entry.originalPath,
      family: entry.family,
      classification: entry.classification,
      warning: entry.warning
    })),
    summary: {
      entries: entries.length,
      current: entries.filter((entry) => entry.classification === 'current').length,
      legacy: entries.filter((entry) => entry.classification === 'legacy').length,
      unreadable: unreadable.length
    }
  }
}

module.exports = { verify }
