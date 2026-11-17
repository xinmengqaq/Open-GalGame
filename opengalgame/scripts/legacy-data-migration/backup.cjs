'use strict'

const { randomUUID } = require('node:crypto')
const { copyFile, lstat, mkdir, readFile, rename, rm } = require('node:fs/promises')
const { dirname, join } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const { inventory } = require('./inventory.cjs')
const { createManifest, assertBatchId, isoNow, sha256, writeManifestAtomic } = require('./manifest.cjs')
const {
  assertBackupRootOutsideSources,
  isInside,
  relativePosix,
  resolveInside
} = require('./scope.cjs')

function sourceRootFor(item, stateRoot, projectRoots) {
  if (item.family === 'execution') {
    if (stateRoot === null || !isInside(stateRoot, item.path)) {
      throw new MigrationError(`执行记录不在状态根内：${item.path}`)
    }
    return { root: stateRoot, namespace: 'state' }
  }
  for (let index = 0; index < projectRoots.length; index += 1) {
    const root = projectRoots[index]
    if (isInside(root, item.path)) return { root, namespace: `project-${index}` }
  }
  throw new MigrationError(`数据文件不在任何显式工程根内：${item.path}`)
}

function itemBackupPath(item, stateRoot, projectRoots) {
  const source = sourceRootFor(item, stateRoot, projectRoots)
  const relative = relativePosix(source.root, item.path, '备份源路径')
  return `files/${source.namespace}/${relative}`
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

async function backup({ stateRoot, projectRoots, backupRoot, batchId, apply }) {
  assertBatchId(batchId)
  const sourceRoots = [stateRoot, ...projectRoots].filter((root) => root !== null)
  assertBackupRootOutsideSources(backupRoot, sourceRoots)
  const facts = await inventory({ stateRoot, projectRoots })
  const items = [
    ...facts.families.canvas,
    ...facts.families.execution,
    ...facts.families.operation
  ]
  const batchDir = join(backupRoot, batchId)
  if (!isInside(backupRoot, batchDir)) throw new MigrationError('批次目录越出备份根')
  const manifestPath = join(batchDir, 'manifest.json')

  if (!apply) {
    return {
      command: 'backup',
      ok: true,
      dryRun: true,
      batchId,
      backupRoot: batchDir,
      manifestPath,
      scope: facts.scope,
      entries: items.map((item) => ({
        family: item.family,
        originalPath: item.path,
        backupPath: itemBackupPath(item, stateRoot, projectRoots),
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        modifiedAt: item.modifiedAt,
        classification: item.classification
      })),
      summary: facts.summary
    }
  }

  if (await exists(batchDir)) {
    throw new MigrationError(`备份批次目录已存在，拒绝覆盖：${batchDir}`)
  }
  const staging = join(backupRoot, `.staging-${batchId}-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    const entries = []
    const backedUpAt = isoNow()
    for (const item of items) {
      const backupPath = itemBackupPath(item, stateRoot, projectRoots)
      const target = await resolveInside(staging, backupPath, '备份目标')
      await mkdir(dirname(target), { recursive: true })
      await copyFile(item.path, target)
      const stats = await lstat(target)
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== item.sizeBytes) {
        throw new MigrationError(`备份大小校验失败：${item.path}`, { exitCode: 3 })
      }
      const copiedBytes = await readFile(target)
      if (sha256(copiedBytes) !== item.sha256) {
        throw new MigrationError(`备份摘要校验失败：${item.path}`, { exitCode: 3 })
      }
      entries.push({
        family: item.family,
        originalPath: item.path,
        backupPath,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        modifiedAt: item.modifiedAt,
        backedUpAt
      })
    }
    const manifest = createManifest({
      batchId,
      scope: facts.scope,
      backupRoot: batchDir,
      entries
    })
    await writeManifestAtomic(join(staging, 'manifest.json'), manifest)
    await rename(staging, batchDir)
    return {
      command: 'backup',
      ok: true,
      dryRun: false,
      batchId,
      backupRoot: batchDir,
      manifestPath,
      manifest,
      summary: facts.summary
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

module.exports = { backup, itemBackupPath, sourceRootFor }
