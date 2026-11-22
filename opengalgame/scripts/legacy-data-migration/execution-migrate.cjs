#!/usr/bin/env node
'use strict'

const { randomUUID } = require('node:crypto')
const { lstat, mkdtemp, readFile, readdir, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { build } = require('esbuild')

const { MigrationError } = require('./errors.cjs')
const { realDirectory } = require('./scope.cjs')

const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RESERVED_PROJECTS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'lpt1', 'lpt2'])
const POLLUTED_PROJECTS = new Set(['__proto__', 'constructor', 'prototype'])

const USAGE = `生成执行记录批量迁移入口（R29）

用法：
  node scripts/legacy-data-migration/execution-migrate.cjs --state-root <绝对路径> [--project <projectId> ...] [--apply]

默认 dry-run，只读列出每个工程的当前化/归档计划；--apply 才按产品同一迁移实现写入。
迁移实现来自产品 ExecutionRecordMigration（esbuild 现场装载），不是第二套迁移逻辑。
未指定 --project 时只枚举显式状态根下 scene-generation/projects 的直属工程，不扫描其他目录。`

let cachedMigration = null

async function loadMigrationModule() {
  if (cachedMigration !== null) return cachedMigration
  const packageRoot = resolve(__dirname, '..', '..')
  const sourceRoot = join(packageRoot, 'src')
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-r29-migration-'))
  const outfile = join(directory, `execution-migration-${randomUUID()}.cjs`)
  try {
    await build({
      absWorkingDir: packageRoot,
      entryPoints: [
        join(sourceRoot, 'infrastructure/scene-generation/execution/ExecutionRecordMigration.ts')
      ],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      external: ['electron'],
      alias: {
        '@bootstrap': join(sourceRoot, 'bootstrap'),
        '@presentation': join(sourceRoot, 'presentation'),
        '@interfaces': join(sourceRoot, 'interfaces'),
        '@application': join(sourceRoot, 'application'),
        '@domain': join(sourceRoot, 'domain'),
        '@infrastructure': join(sourceRoot, 'infrastructure'),
        '@common': join(sourceRoot, 'common')
      }
    })
    cachedMigration = require(outfile)
    return cachedMigration
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new MigrationError(`R29 产品迁移模块装载失败：${message}`, { exitCode: 4 })
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { command: 'help' }
  if (argv.length === 0) throw new MigrationError('migrate 需要 --state-root')
  const start = argv[0] === 'migrate' ? 1 : argv[0].startsWith('--') ? 0 : -1
  if (start === -1) throw new MigrationError(`未知命令：${String(argv[0])}`)
  const options = { apply: false, stateRoot: null, projects: [] }
  for (let index = start; index < argv.length; index += 1) {
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
    if (name === '--state-root') {
      options.stateRoot = value
    } else if (name === '--project') {
      options.projects.push(value)
    } else {
      throw new MigrationError(`未知选项：${name}`)
    }
  }
  return { command: 'migrate', options }
}

function assertProjectId(value) {
  if (
    typeof value !== 'string' ||
    !PROJECT_SEGMENT.test(value) ||
    value === '.' ||
    value === '..' ||
    RESERVED_PROJECTS.has(value.toLowerCase()) ||
    POLLUTED_PROJECTS.has(value)
  ) {
    throw new MigrationError(`工程标识不合法：${String(value)}`)
  }
  return value
}

async function regularFileBytes(path) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MigrationError('执行记录文件不存在', { exitCode: 3 })
    }
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new MigrationError('执行记录不是普通文件', { exitCode: 3 })
  }
  return readFile(path)
}

async function discoverProjects(stateRoot, explicit) {
  if (explicit.length > 0) return explicit.map((projectId) => assertProjectId(projectId))
  const projectsRoot = join(stateRoot, 'scene-generation', 'projects')
  let entries
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new MigrationError('状态根下的工程目录无法读取', {
      exitCode: 4,
      details: { cause: error.code }
    })
  }
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!PROJECT_SEGMENT.test(entry.name)) continue
    const documentPath = join(projectsRoot, entry.name, 'executions.json')
    try {
      const stats = await lstat(documentPath)
      if (stats.isFile() && !stats.isSymbolicLink()) projects.push(entry.name)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return projects.sort()
}

async function migrateProject(migration, stateRoot, projectId, apply) {
  const documentPath = join(stateRoot, 'scene-generation', 'projects', projectId, 'executions.json')
  const result = {
    projectId,
    documentPath,
    status: 'unchanged',
    envelopeVersion: null,
    counts: null,
    rewrite: false,
    targetSha256: null,
    archiveDirectory: null,
    blocked: false,
    blockedRecords: [],
    blockedReason: null,
    remediation: null
  }
  let bytes
  try {
    bytes = await regularFileBytes(documentPath)
  } catch (error) {
    if (error instanceof MigrationError) {
      result.status = 'failed'
      result.error = error.message
      return result
    }
    throw error
  }
  const relativePath = `scene-generation/projects/${projectId}/executions.json`
  try {
    const plan = migration.planExecutionRecordMigration(bytes, projectId)
    result.envelopeVersion = plan.envelopeVersion
    result.counts = plan.counts
    result.rewrite = plan.rewrite
    result.targetSha256 = plan.targetSha256
    if (plan.blocked) {
      result.blocked = true
      result.blockedRecords = plan.blockedRecords
      result.blockedReason = migration.legacyMigrationBlockedMessage(plan.blockedRecords)
      result.remediation =
        '请先用旧版打开该工程，完成或取消未结束操作（或明确保留草稿），再重新迁移；归档不是可继续的数据源。'
      result.status = 'blocked'
      return result
    }
    if (plan.rewrite) {
      result.archiveDirectory = join(
        stateRoot,
        'scene-generation',
        'projects',
        projectId,
        'legacy-executions',
        plan.sourceSha256
      )
    }
    if (!apply) {
      result.status = plan.rewrite ? 'planned' : 'unchanged'
      return result
    }
    const run = await migration.migrateExecutionRecordFile({
      stateRoot,
      projectId,
      relativePath,
      documentPath,
      bytes
    })
    result.status =
      run.outcome === 'migrated' ? 'migrated' : run.outcome === 'failed' ? 'failed' : 'unchanged'
    result.archiveDirectory = run.archiveDirectory ?? result.archiveDirectory
    if (run.archiveReused !== undefined) result.archiveReused = run.archiveReused
    if (run.error !== undefined) result.error = run.error
    return result
  } catch (error) {
    result.status = 'failed'
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

async function run(argv) {
  const { command, options } = parseArgs(argv)
  if (command === 'help') return null
  if (options.stateRoot === null) throw new MigrationError('migrate 需要 --state-root')
  const stateRoot = await realDirectory(options.stateRoot, '状态根')
  const projects = await discoverProjects(stateRoot, options.projects)
  const migration = await loadMigrationModule()
  const results = []
  for (const projectId of projects) {
    results.push(await migrateProject(migration, stateRoot, projectId, options.apply))
  }
  const failures = results.filter((result) => result.status === 'failed')
  const blocked = results.filter((result) => result.status === 'blocked')
  const payload = {
    command: 'migrate',
    ok: failures.length === 0 && blocked.length === 0,
    dryRun: !options.apply,
    stateRoot,
    projects: results,
    summary: {
      projects: results.length,
      unchanged: results.filter((result) => result.status === 'unchanged').length,
      planned: results.filter((result) => result.status === 'planned').length,
      migrated: results.filter((result) => result.status === 'migrated').length,
      blocked: blocked.length,
      failed: failures.length
    }
  }
  // dry-run 只报告阻断；--apply 未完成任何阻断工程时用非零退出码提醒运维。
  if (failures.length > 0 || (options.apply && blocked.length > 0)) {
    process.exitCode = 3
    return payload
  }
  return payload
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
