import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const MIGRATE_PATH = fileURLToPath(
  new URL('../../../scripts/legacy-data-migration/execution-migrate.cjs', import.meta.url)
)
const ARCHIVE_PATH = fileURLToPath(
  new URL('../../../scripts/legacy-data-migration/execution-archive.cjs', import.meta.url)
)

interface MigrateProjectResult {
  projectId: string
  status: string
  blocked?: boolean
  blockedRecords?: Array<{ operationId: string; state: string }>
  blockedReason?: string
  remediation?: string
  counts?: Record<string, number>
}

interface MigratePayload {
  ok: boolean
  summary: Record<string, number>
  projects: MigrateProjectResult[]
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('批量迁移遇未结束旧记录时 dry-run/--apply 都报告阻断且零写，结算后正常迁移', async () => {
  const stateRoot = await temporaryRoot('opengalgame-r29-blocked-')
  const current = currentRecord({ operationId: 'operation-current' })
  const waiting = legacyRecord({ operationId: 'operation-waiting-repair', state: 'waiting' })
  const terminal = legacyRecord({ operationId: 'operation-legacy-terminal', state: 'failed' })
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 1, executions: [current, waiting, terminal] })
  )
  const path = await writeDocument(stateRoot, 'project-1', sourceBytes)
  const archiveRoot = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions'
  )

  const dryRun = await runNode(MIGRATE_PATH, ['--state-root', stateRoot])
  expect(dryRun.code).toBe(0)
  const dryJson = dryRun.json as MigratePayload
  const dryProject = dryJson.projects[0]
  expect(dryProject).toMatchObject({
    projectId: 'project-1',
    status: 'blocked',
    blocked: true,
    counts: { total: 3, current: 1, legacy: 2 },
    blockedRecords: [{ operationId: 'operation-waiting-repair', state: 'waiting' }]
  })
  expect(dryProject?.blockedReason).toEqual(expect.stringContaining('旧版生成记录仍有未结束操作'))
  expect(dryProject?.remediation).toEqual(expect.stringContaining('先用旧版'))
  expect(dryJson.ok).toBe(false)
  expect(dryJson.summary.blocked).toBe(1)
  expect(await readFile(path)).toEqual(sourceBytes)
  await expect(readdir(archiveRoot)).rejects.toMatchObject({ code: 'ENOENT' })

  const applied = await runNode(MIGRATE_PATH, ['--state-root', stateRoot, '--apply'])
  expect(applied.code).toBe(3)
  const appliedJson = applied.json as MigratePayload
  expect(appliedJson.projects[0]).toMatchObject({
    status: 'blocked',
    blocked: true
  })
  expect(await readFile(path)).toEqual(sourceBytes)
  await expect(readdir(archiveRoot)).rejects.toMatchObject({ code: 'ENOENT' })

  // 旧版结算后重跑同一命令：终态旧记录按原归档路径迁移，不再阻断。
  const settled = JSON.parse(sourceBytes.toString('utf8')) as {
    executions: Array<Record<string, unknown>>
  }
  settled.executions[1] = { ...settled.executions[1], state: 'failed' }
  const settledBytes = Buffer.from(JSON.stringify(settled))
  await writeFile(path, settledBytes)
  const retried = await runNode(MIGRATE_PATH, ['--state-root', stateRoot, '--apply'])
  expect(retried.code).toBe(0)
  const retriedJson = retried.json as MigratePayload
  expect(retriedJson.summary).toEqual({
    projects: 1,
    unchanged: 0,
    planned: 0,
    migrated: 1,
    blocked: 0,
    failed: 0
  })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions.map((item) => item.operationId)).toEqual(['operation-current'])
  const archiveDirectory = join(
    archiveRoot,
    createHash('sha256').update(settledBytes).digest('hex')
  )
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(settledBytes)
}, 30_000)

it('批量迁移入口 dry-run 只报告，--apply 与产品首访迁移同一实现且幂等', async () => {
  const stateRoot = await temporaryRoot('opengalgame-r29-batch-')
  const dated = currentRecord({
    operationId: 'operation-dated',
    updatedAt: '2026-11-01T02:00:00.000Z',
    createdAt: '2026-11-01T01:00:00.000Z'
  })
  const legacy = legacyRecord({ operationId: 'operation-legacy' })
  const sourceBytes = Buffer.from(JSON.stringify({ version: 3, executions: [dated, legacy] }))
  const path = await writeDocument(stateRoot, 'project-1', sourceBytes)
  const currentBytes = Buffer.from(
    JSON.stringify({
      version: 7,
      executions: [
        {
          ...currentRecord({
            projectId: 'project-2',
            operationId: 'operation-current',
            updatedAt: '2026-11-02T02:00:00.000Z',
            createdAt: '2026-11-02T01:00:00.000Z'
          }),
          timeline: [
            {
              entryId: 'entry-current',
              sequence: 1,
              createdAt: '2026-11-02T02:00:00.000Z',
              kind: 'stage',
              stage: 'completed',
              message: '已完成'
            }
          ]
        }
      ]
    })
  )
  const otherPath = await writeDocument(stateRoot, 'project-2', currentBytes)

  const dryRun = await runNode(MIGRATE_PATH, ['--state-root', stateRoot])
  expect(dryRun.code).toBe(0)
  const dryJson = dryRun.json as {
    dryRun: boolean
    summary: Record<string, number>
    projects: Array<{ projectId: string; status: string; counts: Record<string, number> }>
  }
  expect(dryJson.dryRun).toBe(true)
  expect(dryJson.summary).toEqual({
    projects: 2,
    unchanged: 1,
    planned: 1,
    migrated: 0,
    blocked: 0,
    failed: 0
  })
  expect(dryJson.projects.find((project) => project.projectId === 'project-1')).toMatchObject({
    status: 'planned',
    counts: { total: 2, current: 1, legacy: 1 }
  })
  expect(await readFile(path)).toEqual(sourceBytes)
  expect(await readFile(otherPath)).toEqual(currentBytes)
  await expect(
    readdir(join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'))
  ).rejects.toMatchObject({ code: 'ENOENT' })

  const applied = await runNode(MIGRATE_PATH, ['--state-root', stateRoot, '--apply'])
  expect(applied.code).toBe(0)
  const appliedJson = applied.json as {
    dryRun: boolean
    projects: Array<{
      projectId: string
      status: string
      archiveDirectory?: string
      error?: string
    }>
  }
  expect(appliedJson.dryRun).toBe(false)
  expect(appliedJson.projects.find((project) => project.projectId === 'project-1')).toMatchObject({
    status: 'migrated'
  })
  const migrated = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string }>
  }
  expect(migrated.version).toBe(7)
  expect(migrated.executions.map((item) => item.operationId)).toEqual(['operation-dated'])
  expect(await readFile(otherPath)).toEqual(currentBytes)

  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)
  const manifestBytes = await readFile(join(archiveDirectory, 'manifest.json'))

  const repeated = await runNode(MIGRATE_PATH, ['--state-root', stateRoot, '--apply'])
  expect(repeated.code).toBe(0)
  const repeatedJson = repeated.json as { summary: Record<string, number> }
  expect(repeatedJson.summary).toEqual({
    projects: 2,
    unchanged: 2,
    planned: 0,
    migrated: 0,
    blocked: 0,
    failed: 0
  })
  expect(await readFile(join(archiveDirectory, 'manifest.json'))).toEqual(manifestBytes)
}, 30_000)

it('归档 verify/restore dry-run/apply 逐字节恢复，且恢复后首访迁移复用同一归档', async () => {
  const stateRoot = await temporaryRoot('opengalgame-r29-archive-')
  const legacy = legacyRecord({ operationId: 'operation-legacy' })
  const datedLegacy = legacyRecord({
    operationId: 'operation-legacy-dated',
    createdAt: '2026-10-01T00:00:00.000Z'
  })
  const sourceBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      executions: [
        currentRecord({
          operationId: 'operation-current',
          updatedAt: '2026-11-01T02:00:00.000Z',
          createdAt: '2026-11-01T01:00:00.000Z'
        }),
        legacy,
        datedLegacy
      ]
    })
  )
  const path = await writeDocument(stateRoot, 'project-1', sourceBytes)
  const applied = await runNode(MIGRATE_PATH, [
    '--state-root',
    stateRoot,
    '--apply',
    '--project',
    'project-1'
  ])
  expect(applied.code).toBe(0)
  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  const manifestPath = join(archiveDirectory, 'manifest.json')
  const migratedBytes = await readFile(path)
  expect(migratedBytes).not.toEqual(sourceBytes)

  const verify = await runNode(ARCHIVE_PATH, [
    'verify',
    '--archive-root',
    join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'),
    '--state-root',
    stateRoot
  ])
  expect(verify.code).toBe(0)
  const verifyJson = verify.json as {
    ok: boolean
    archives: Array<{
      legacyRecords: number
      legacyReasons: Record<string, number>
      counts: Record<string, number>
      continuable: boolean
      unfinishedRecords: unknown[]
    }>
  }
  expect(verifyJson.ok).toBe(true)
  expect(verifyJson.archives).toHaveLength(1)
  expect(verifyJson.archives[0]?.counts).toEqual({ total: 3, current: 1, legacy: 2 })
  expect(verifyJson.archives[0]?.continuable).toBe(false)
  expect(verifyJson.archives[0]?.unfinishedRecords).toEqual([])
  expect(verifyJson.archives[0]?.legacyReasons).toEqual({
    'missing-record-time': 1,
    'current-schema-incomplete': 1
  })

  const singleVerify = await runNode(ARCHIVE_PATH, [
    'verify',
    '--archive-root',
    archiveDirectory,
    '--state-root',
    stateRoot
  ])
  expect(singleVerify.code).toBe(0)

  const dryRestore = await runNode(ARCHIVE_PATH, [
    'restore',
    '--manifest',
    manifestPath,
    '--state-root',
    stateRoot
  ])
  expect(dryRestore.code).toBe(0)
  expect(dryRestore.json).toMatchObject({
    dryRun: true,
    current: { matchesMigratedTarget: true, matchesSource: false }
  })
  expect(await readFile(path)).toEqual(migratedBytes)

  const manifestBytes = await readFile(manifestPath)
  const restore = await runNode(ARCHIVE_PATH, [
    'restore',
    '--manifest',
    manifestPath,
    '--state-root',
    stateRoot,
    '--apply'
  ])
  expect(restore.code).toBe(0)
  expect(await readFile(path)).toEqual(sourceBytes)
  expect(await readFile(manifestPath)).toEqual(manifestBytes)
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)

  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-legacy'
    })
  ).resolves.toBeNull()
  expect(await readFile(manifestPath)).toEqual(manifestBytes)
  expect(await readFile(path)).not.toEqual(sourceBytes)
}, 30_000)

it('verify 拒绝损坏摘要、未知字段、路径越界与符号链接', async () => {
  const stateRoot = await temporaryRoot('opengalgame-r29-archive-bad-')
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 1, executions: [legacyRecord({ operationId: 'operation-legacy' })] })
  )
  const path = await writeDocument(stateRoot, 'project-1', sourceBytes)
  await runNode(MIGRATE_PATH, ['--state-root', stateRoot, '--apply'])
  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  const manifestPath = join(archiveDirectory, 'manifest.json')
  const sourcePath = join(archiveDirectory, 'source.json')
  const originalManifest = await readFile(manifestPath)

  await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n')]))
  expect((await runNode(ARCHIVE_PATH, ['verify', '--archive-root', archiveDirectory])).code).toBe(3)
  await writeFile(sourcePath, sourceBytes)

  const manifest = JSON.parse(originalManifest.toString('utf8')) as {
    source: Record<string, unknown>
    [key: string]: unknown
  }
  await writeFile(manifestPath, JSON.stringify({ ...manifest, extra: true }))
  expect((await runNode(ARCHIVE_PATH, ['verify', '--archive-root', archiveDirectory])).code).toBe(3)
  const source = manifest.source
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      source: { ...source, relativePath: '../escape' }
    })
  )
  expect((await runNode(ARCHIVE_PATH, ['verify', '--archive-root', archiveDirectory])).code).toBe(3)
  await writeFile(manifestPath, originalManifest)

  const otherRoot = await temporaryRoot('opengalgame-r29-archive-other-')
  expect(
    (
      await runNode(ARCHIVE_PATH, [
        'verify',
        '--archive-root',
        archiveDirectory,
        '--state-root',
        otherRoot
      ])
    ).code
  ).toBe(3)
  expect(
    (
      await runNode(ARCHIVE_PATH, [
        'restore',
        '--manifest',
        manifestPath,
        '--state-root',
        otherRoot,
        '--apply'
      ])
    ).code
  ).toBe(3)
  expect(await readFile(path)).not.toEqual(sourceBytes)

  const moved = join(stateRoot, 'moved-archives')
  const archiveName = createHash('sha256').update(sourceBytes).digest('hex')
  await mkdir(moved)
  await rename(
    join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'),
    join(moved, archiveName)
  )
  let linked = false
  try {
    await symlink(
      join(moved, archiveName),
      join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    linked = true
  } catch {
    linked = false
  }
  if (linked) {
    const result = await runNode(ARCHIVE_PATH, [
      'verify',
      '--archive-root',
      join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'),
      '--state-root',
      stateRoot
    ])
    expect(result.code).toBe(3)
  }
}, 30_000)

it('execution-migrate 与 execution-archive 的用法/路径错误分别返回 2 和 3', async () => {
  const missing = await runNode(MIGRATE_PATH, [])
  expect(missing.code).toBe(2)
  const relative = await runNode(MIGRATE_PATH, ['--state-root', 'relative/path'])
  expect(relative.code).toBe(2)
  const unknown = await runNode(ARCHIVE_PATH, ['frobnicate'])
  expect(unknown.code).toBe(2)
  const noRoot = await runNode(ARCHIVE_PATH, ['verify'])
  expect(noRoot.code).toBe(2)
  const missingManifest = await runNode(ARCHIVE_PATH, [
    'restore',
    '--manifest',
    join(tmpdir(), 'opengalgame-r29-missing', 'manifest.json'),
    '--state-root',
    tmpdir()
  ])
  expect(missingManifest.code).toBe(3)
}, 20_000)

function currentExecution(): Record<string, unknown> {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-current',
    threadId: 'thread-current',
    branchId: 'branch-current',
    fingerprint: 'fingerprint-current',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'v1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'succeeded',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  }
}

function currentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...currentExecution(), ...overrides }
}

function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-legacy',
    threadId: 'thread-legacy',
    branchId: 'branch-legacy',
    fingerprint: 'fingerprint-legacy',
    state: 'succeeded',
    inputSnapshot: { prompts: [{ id: 'story', sourceId: 'story', body: '旧正文' }] },
    ...overrides
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writeDocument(stateRoot: string, projectId: string, bytes: Buffer): Promise<string> {
  const directory = join(stateRoot, 'scene-generation/projects', projectId)
  const path = join(directory, 'executions.json')
  await mkdir(directory, { recursive: true })
  await writeFile(path, bytes)
  return path
}

async function runNode(
  script: string,
  args: readonly string[]
): Promise<{ code: number; json: Record<string, unknown>; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    })
    return { code: 0, json: JSON.parse(stdout) as Record<string, unknown>, stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    const stdout = failed.stdout ?? ''
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      json: stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>),
      stderr: failed.stderr ?? ''
    }
  }
}
