#!/usr/bin/env node
'use strict'

const { backup } = require('./backup.cjs')
const { MigrationError } = require('./errors.cjs')
const { inventory } = require('./inventory.cjs')
const { assertBatchId, newBatchId } = require('./manifest.cjs')
const { restore } = require('./restore.cjs')
const {
  assertBackupRootOutsideSources,
  assertRootsDisjoint,
  realDirectory
} = require('./scope.cjs')
const { verify } = require('./verify.cjs')

const USAGE = `旧数据迁移工具（R27）

用法：
  node scripts/legacy-data-migration/cli.cjs inventory --state-root <绝对路径> [--project-root <绝对路径> ...]
  node scripts/legacy-data-migration/cli.cjs backup --state-root <绝对路径> [--project-root <绝对路径> ...] --backup-root <绝对路径> [--batch-id <ID>] [--apply]
  node scripts/legacy-data-migration/cli.cjs verify --manifest <绝对路径> [--backup-root <绝对路径>] [--allow-unreadable]
  node scripts/legacy-data-migration/cli.cjs restore --manifest <绝对路径> [--backup-root <绝对路径>] --state-root <绝对路径> [--project-root <绝对路径> ...] [--apply] [--allow-unreadable]

默认 dry-run：backup/restore 只有显式 --apply 才写入。inventory/verify 永远只读。
只操作显式传入的绝对路径；不自动扫描用户目录；不删除原件；不接产品运行时。`

function parseArgs(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') return { command: 'help' }
  const options = {
    apply: false,
    allowUnreadable: false,
    stateRoot: null,
    projectRoots: [],
    backupRoot: null,
    manifest: null,
    batchId: null
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') {
      options.apply = true
      continue
    }
    if (token === '--allow-unreadable') {
      options.allowUnreadable = true
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
    if (name === '--state-root') options.stateRoot = value
    else if (name === '--project-root') options.projectRoots.push(value)
    else if (name === '--backup-root') options.backupRoot = value
    else if (name === '--manifest') options.manifest = value
    else if (name === '--batch-id') options.batchId = value
    else throw new MigrationError(`未知选项：${name}`)
  }
  return { command, options }
}

async function canonicalRoots(options) {
  const stateRoot = options.stateRoot === null ? null : await realDirectory(options.stateRoot, '状态根')
  const projectRoots = []
  for (const root of options.projectRoots) {
    projectRoots.push(await realDirectory(root, '工程根'))
  }
  assertRootsDisjoint([stateRoot, ...projectRoots].filter((root) => root !== null))
  return { stateRoot, projectRoots }
}

function assertRootPresent(stateRoot, projectRoots) {
  if (stateRoot === null && projectRoots.length === 0) {
    throw new MigrationError('至少需要传入 --state-root 或一个 --project-root')
  }
}

function assertNoApply(command, apply) {
  if (apply) throw new MigrationError(`${command} 不接受 --apply`)
}

async function run(argv) {
  const { command, options } = parseArgs(argv)
  if (command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return null
  }

  if (command === 'inventory') {
    assertNoApply(command, options.apply)
    if (
      options.allowUnreadable ||
      options.backupRoot !== null ||
      options.manifest !== null ||
      options.batchId !== null
    ) {
      throw new MigrationError('inventory 只接受 --state-root/--project-root')
    }
    const { stateRoot, projectRoots } = await canonicalRoots(options)
    assertRootPresent(stateRoot, projectRoots)
    return inventory({ stateRoot, projectRoots })
  }

  if (command === 'backup') {
    if (options.allowUnreadable) throw new MigrationError('backup 不接受 --allow-unreadable')
    if (options.manifest !== null) throw new MigrationError('backup 不接受 --manifest')
    const { stateRoot, projectRoots } = await canonicalRoots(options)
    assertRootPresent(stateRoot, projectRoots)
    if (options.backupRoot === null) throw new MigrationError('backup 需要 --backup-root')
    const backupRoot = await realDirectory(options.backupRoot, '备份根')
    assertBackupRootOutsideSources(backupRoot, [stateRoot, ...projectRoots].filter(Boolean))
    const batchId = assertBatchId(options.batchId ?? newBatchId())
    return backup({ stateRoot, projectRoots, backupRoot, batchId, apply: options.apply })
  }

  if (command === 'verify') {
    assertNoApply(command, options.apply)
    if (options.stateRoot !== null || options.projectRoots.length > 0 || options.batchId !== null) {
      throw new MigrationError('verify 只接受 --manifest/--backup-root/--allow-unreadable')
    }
    if (options.manifest === null) throw new MigrationError('verify 需要 --manifest')
    const backupRoot =
      options.backupRoot === null ? null : await realDirectory(options.backupRoot, '备份根')
    return verify({
      manifestPath: options.manifest,
      backupRoot,
      allowUnreadable: options.allowUnreadable
    })
  }

  if (command === 'restore') {
    if (options.batchId !== null) throw new MigrationError('restore 不接受 --batch-id')
    if (options.manifest === null) throw new MigrationError('restore 需要 --manifest')
    const { stateRoot, projectRoots } = await canonicalRoots(options)
    assertRootPresent(stateRoot, projectRoots)
    const backupRoot =
      options.backupRoot === null ? null : await realDirectory(options.backupRoot, '备份根')
    return restore({
      manifestPath: options.manifest,
      backupRoot,
      stateRoot,
      projectRoots,
      apply: options.apply,
      allowUnreadable: options.allowUnreadable
    })
  }

  throw new MigrationError(`未知命令：${String(command)}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? null
  try {
    const result = await run(argv)
    if (result === null) return
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    const exitCode = error instanceof MigrationError ? error.exitCode : 4
    const payload = {
      ok: false,
      command,
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
