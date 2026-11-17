'use strict'

const { randomUUID } = require('node:crypto')
const { copyFile, lstat, mkdir, open, readFile, rename, rm } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')

const { MigrationError } = require('./errors.cjs')
const { assertFamilyPathAndNamespace, readManifest, sha256 } = require('./manifest.cjs')
const {
  assertNoSymlinkComponents,
  assertRootSetsEqual,
  canonicalInside,
  isInside,
  pathKey,
  relativePosix,
  resolveInside,
  scopeRoots
} = require('./scope.cjs')
const { verify } = require('./verify.cjs')

function findRoot(entryPath, stateRoot, projectRoots) {
  const matches = []
  if (stateRoot !== null && isInside(stateRoot, entryPath)) matches.push(stateRoot)
  for (const root of projectRoots) {
    if (isInside(root, entryPath)) matches.push(root)
  }
  if (matches.length !== 1) {
    throw new MigrationError(`原路径必须恰好属于一个传入根：${entryPath}`, {
      details: { matches }
    })
  }
  return matches[0]
}

async function writeAtomically(target, bytes) {
  const temporary = join(dirname(target), `.legacy-restore-${randomUUID()}`)
  const handle = await open(temporary, 'wx')
  try {
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
    await rm(temporary, { force: true })
    throw error
  }
}

async function restore({
  manifestPath,
  backupRoot: backupRootOverride,
  stateRoot,
  projectRoots,
  apply,
  allowUnreadable = false
}) {
  const manifest = await readManifest(manifestPath)
  const explicitRoots = [stateRoot, ...projectRoots].filter((root) => root !== null)
  assertRootSetsEqual(scopeRoots(manifest.scope), explicitRoots)

  const verified = await verify({
    manifestPath,
    backupRoot: backupRootOverride,
    allowUnreadable
  })
  if (!verified.readable && !allowUnreadable) {
    throw new MigrationError(
      '备份含不可读数据，默认拒绝恢复；仅显式 --allow-unreadable 允许按原始字节恢复，且不表示可读/可续跑',
      { exitCode: 3 }
    )
  }
  const backupRoot = verified.backupRoot
  const verifiedByOriginal = new Map(
    verified.entries.map((entry) => [
      pathKey(resolve(entry.originalPath)),
      entry.classification
    ])
  )
  const plans = []
  const canonicalTargets = new Set()
  for (const entry of manifest.entries) {
    const root = findRoot(entry.originalPath, stateRoot, projectRoots)
    const relative = relativePosix(root, entry.originalPath, '恢复原路径')
    let target
    try {
      const lexicalTarget = await resolveInside(root, relative, '恢复目标')
      await assertNoSymlinkComponents(root, lexicalTarget, '恢复目标')
      target = await canonicalInside(root, relative, '恢复目标')
      assertFamilyPathAndNamespace({ ...entry, originalPath: target }, manifest.scope)
    } catch (error) {
      if (error instanceof MigrationError) error.exitCode = 3
      throw error
    }
    const targetKey = pathKey(target)
    if (canonicalTargets.has(targetKey)) {
      throw new MigrationError(
        `manifest 多个条目规范化后指向同一目标：${target}`,
        { exitCode: 3 }
      )
    }
    canonicalTargets.add(targetKey)
    let existing = null
    try {
      existing = await lstat(target)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new MigrationError(`恢复目标无法检查：${target}`, {
          exitCode: 4,
          details: { cause: error.code }
        })
      }
    }
    if (existing?.isSymbolicLink() || (existing !== null && !existing.isFile())) {
      throw new MigrationError(`恢复目标不是普通文件：${target}`)
    }
    const backupFile = await resolveInside(backupRoot, entry.backupPath, '备份文件')
    plans.push({
      entry,
      target,
      backupFile,
      classification: verifiedByOriginal.get(pathKey(resolve(entry.originalPath))) ?? 'unreadable'
    })
  }

  const wouldRestore = plans.map(({ entry, target, classification }) => ({
    family: entry.family,
    originalPath: entry.originalPath,
    target,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    classification
  }))

  if (!apply) {
    return {
      command: 'restore',
      ok: true,
      dryRun: true,
      manifestPath,
      batchId: manifest.batchId,
      backupRoot,
      scope: manifest.scope,
      readable: verified.readable,
      formatOk: verified.readable,
      bytesOnly: !verified.readable,
      wouldRestore
    }
  }

  const restored = []
  for (const plan of plans) {
    const bytes = await readFile(plan.backupFile)
    if (bytes.byteLength !== plan.entry.sizeBytes || sha256(bytes) !== plan.entry.sha256) {
      throw new MigrationError(`恢复前备份复核失败：${plan.entry.backupPath}`, { exitCode: 3 })
    }
    await mkdir(dirname(plan.target), { recursive: true })
    await assertNoSymlinkComponents(
      findRoot(plan.entry.originalPath, stateRoot, projectRoots),
      plan.target,
      '恢复目标'
    )
    await writeAtomically(plan.target, bytes)
    restored.push({
      family: plan.entry.family,
      originalPath: plan.entry.originalPath,
      sizeBytes: plan.entry.sizeBytes,
      sha256: plan.entry.sha256,
      classification: plan.classification
    })
  }

  return {
    command: 'restore',
    ok: true,
    dryRun: false,
    manifestPath,
    batchId: manifest.batchId,
    backupRoot,
    scope: manifest.scope,
    readable: verified.readable,
    formatOk: verified.readable,
    bytesOnly: !verified.readable,
    restored
  }
}

module.exports = { restore, writeAtomically }
