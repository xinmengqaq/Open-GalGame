import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  readOperationRecord,
  writeOperationRecord,
  type OperationRecord
} from '@infrastructure/git/transaction/OperationRecord'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

const inventoryOutputSchema = z.object({
  families: z.object({
    operation: z.array(
      z.object({
        classification: z.string(),
        rollbackIndex: z.record(z.string(), z.unknown())
      })
    )
  })
})

const verifyOutputSchema = z.object({
  ok: z.boolean(),
  readable: z.boolean(),
  scope: z.object({ projectRoots: z.array(z.string()) }),
  entries: z.array(
    z.object({
      classification: z.string(),
      rollbackIndex: z.record(z.string(), z.unknown())
    })
  )
})

const renameControl = vi.hoisted(() => ({ failTo: null as string | null }))
const readControl = vi.hoisted(() => ({
  failTo: null as string | null,
  manifestReads: 0,
  failManifestRead: null as number | null
}))

function injectedPathMatches(candidate: string, control: string): boolean {
  const left = resolve(candidate)
  const right = resolve(control)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      if (path.endsWith('manifest.json') && path.includes('legacy-operations')) {
        readControl.manifestReads += 1
        if (
          readControl.failManifestRead !== null &&
          readControl.manifestReads === readControl.failManifestRead
        ) {
          const error = new Error('injected post-publish read failure') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
      }
      if (readControl.failTo !== null && injectedPathMatches(path, readControl.failTo)) {
        const error = new Error('injected read failure') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return actual.readFile(...args)
    },
    rename: async (from: string, to: string) => {
      if (renameControl.failTo !== null && injectedPathMatches(to, renameControl.failTo)) {
        const error = new Error('injected rename failure') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return actual.rename(from, to)
    }
  }
})

const CLI_PATH = fileURLToPath(
  new URL('../../../scripts/legacy-data-migration/cli.cjs', import.meta.url)
)
const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  renameControl.failTo = null
  readControl.failTo = null
  readControl.manifestReads = 0
  readControl.failManifestRead = null
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const indexBytes = Buffer.from('index-bytes')
  return {
    formatVersion: 1,
    operationId: 'op-current',
    phase: 'published',
    baselineCommitId: 'a'.repeat(40),
    branch: 'main',
    fingerprint: 'fingerprint-operation',
    candidateRevisionId: 'b'.repeat(40),
    forwardCommitId: 'c'.repeat(40),
    rollbackCommitId: null,
    paths: [
      {
        relativePath: 'game/start.txt',
        action: 'modify',
        originalBytesBase64: Buffer.from('original-bytes').toString('base64'),
        intendedDigest: sha256(Buffer.from('intended-bytes')),
        originalStageOid: null
      }
    ],
    indexBytesBase64: indexBytes.toString('base64'),
    indexDigest: sha256(indexBytes),
    ...overrides
  }
}

async function temporaryProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  await mkdir(join(root, '.git'), { recursive: true })
  return root
}

async function writeLegacyRecord(
  projectRoot: string,
  overrides: Record<string, unknown> = {}
): Promise<{ path: string; bytes: Buffer }> {
  const bytes = Buffer.from(
    JSON.stringify(
      legacyRecord({
        rollbackIndexBytesBase64: Buffer.from('legacy-index-bytes').toString('base64'),
        ...overrides
      })
    ),
    'utf8'
  )
  const path = join(projectRoot, '.git', 'opengalgame', 'operations', 'op-current.json')
  await mkdir(join(projectRoot, '.git', 'opengalgame', 'operations'), { recursive: true })
  await writeFile(path, bytes)
  return { path, bytes }
}

async function runCli(args: readonly string[]): Promise<{
  code: number
  json: Record<string, unknown>
  stdout: string
  stderr: string
}> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd: join(CLI_PATH, '..', '..', '..'),
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    })
    return { code: 0, json: JSON.parse(stdout) as Record<string, unknown>, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    const stdout = failed.stdout ?? ''
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      json: stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>),
      stdout,
      stderr: failed.stderr ?? ''
    }
  }
}

async function archiveDirectoryFor(projectRoot: string): Promise<string> {
  const root = join(projectRoot, '.git', 'opengalgame', 'legacy-operations')
  const names = await readdir(root)
  expect(names).toHaveLength(1)
  return join(root, names[0]!)
}

it('首访迁移生成 R27 原生 manifest：inventory 源只读，真实 verify/restore 可消费', async () => {
  const projectRoot = await temporaryProject('opengalgame-r32-scripts-')
  const { path: operationPath, bytes: sourceBytes } = await writeLegacyRecord(projectRoot)
  const projectReal = await realpath(projectRoot)

  const inventory = await runCli(['inventory', '--project-root', projectRoot])
  expect(inventory.code).toBe(0)
  const inventoryOperation = inventoryOutputSchema.parse(inventory.json).families.operation[0]
  expect(inventoryOperation).toMatchObject({
    classification: 'current',
    rollbackIndex: {
      source: { field: 'rollbackIndexBytesBase64' },
      present: true,
      decodable: true,
      usedByRollback: false,
      classification: 'legacy-optional-unused',
      readImpact: 'none'
    }
  })
  expect(await readFile(operationPath)).toEqual(sourceBytes)
  await expect(
    readdir(join(projectRoot, '.git', 'opengalgame', 'legacy-operations'))
  ).rejects.toMatchObject({ code: 'ENOENT' })

  const read = await readOperationRecord(projectRoot, 'op-current')
  expect(read.kind).toBe('ok')
  if (read.kind !== 'ok') throw new Error('旧记录迁移后应可读')
  expect(Object.hasOwn(read.record, 'rollbackIndexBytesBase64')).toBe(false)
  expect(await readFile(operationPath)).not.toEqual(sourceBytes)

  const archiveDirectory = await archiveDirectoryFor(projectRoot)
  const manifestPath = join(archiveDirectory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    batchId: string
    backupRoot: string
    scope: {
      projectRoots: string[]
      visitedProjects: string[]
      unvisitedProjects: { known: boolean; count: number | null; note: string }
    }
  }
  expect(manifest.batchId).toBe(archiveDirectory.split(/[\\/]/u).at(-1))
  expect(manifest.backupRoot).toBe(archiveDirectory)
  expect(manifest.scope.projectRoots).toEqual([projectReal])
  expect(manifest.scope.visitedProjects).toEqual([projectReal])
  expect(manifest.scope.unvisitedProjects).toMatchObject({ known: false, count: null })
  expect(manifest.scope.unvisitedProjects.note).toContain('未访问')

  const verified = await runCli(['verify', '--manifest', manifestPath])
  expect(verified.code).toBe(0)
  const verifyJson = verifyOutputSchema.parse(verified.json)
  expect(verifyJson).toMatchObject({
    ok: true,
    readable: true,
    scope: { projectRoots: [projectReal] }
  })
  expect(verifyJson.entries[0]).toMatchObject({
    classification: 'current',
    rollbackIndex: {
      present: true,
      decodable: true,
      usedByRollback: false,
      classification: 'legacy-optional-unused'
    }
  })
  expect(await readFile(operationPath)).not.toEqual(sourceBytes)

  const restored = await runCli([
    'restore',
    '--manifest',
    manifestPath,
    '--project-root',
    projectRoot,
    '--apply'
  ])
  expect(restored.code).toBe(0)
  expect(restored.json).toMatchObject({
    ok: true,
    dryRun: false,
    restored: [{ originalPath: operationPath }]
  })
  expect(await readFile(operationPath)).toEqual(sourceBytes)

  await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  expect(await readdir(join(projectRoot, '.git', 'opengalgame', 'legacy-operations'))).toHaveLength(
    1
  )
})

it('同字节不同工程路径产生不同 batchId，未访问工程保持原文且不生成归档', async () => {
  const firstProject = await temporaryProject('opengalgame-r32-first-')
  const secondProject = await temporaryProject('opengalgame-r32-second-')
  const first = await writeLegacyRecord(firstProject)
  const second = await writeLegacyRecord(secondProject)
  expect(second.bytes).toEqual(first.bytes)

  await expect(readOperationRecord(firstProject, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  expect(await readFile(second.path)).toEqual(second.bytes)
  await expect(
    readdir(join(secondProject, '.git', 'opengalgame', 'legacy-operations'))
  ).rejects.toMatchObject({ code: 'ENOENT' })

  const firstArchive = await archiveDirectoryFor(firstProject)
  await expect(readOperationRecord(secondProject, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  const secondArchive = await archiveDirectoryFor(secondProject)
  expect(firstArchive.split(/[\\/]/u).at(-1)).not.toBe(secondArchive.split(/[\\/]/u).at(-1))
})

it('非法 base64 与 null 保持 damaged，不写源、不生成归档', async () => {
  for (const value of ['***not-base64***', null]) {
    const projectRoot = await temporaryProject('opengalgame-r32-invalid-')
    const { path: operationPath, bytes } = await writeLegacyRecord(projectRoot, {
      rollbackIndexBytesBase64: value
    })
    await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toEqual({
      kind: 'damaged'
    })
    expect(await readFile(operationPath)).toEqual(bytes)
    await expect(
      readdir(join(projectRoot, '.git', 'opengalgame', 'legacy-operations'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('归档损坏时读取保留旧行为、覆盖写拒绝，修复后重试成功', async () => {
  const projectRoot = await temporaryProject('opengalgame-r32-corrupt-')
  const { path: operationPath, bytes: sourceBytes } = await writeLegacyRecord(projectRoot)
  const firstRead = await readOperationRecord(projectRoot, 'op-current')
  expect(firstRead.kind).toBe('ok')
  if (firstRead.kind !== 'ok') throw new Error('首次读取应成功')
  const normalized: OperationRecord = firstRead.record
  const archiveDirectory = await archiveDirectoryFor(projectRoot)
  await writeFile(join(archiveDirectory, 'manifest.json'), '{"formatVersion":1}')
  await writeFile(operationPath, sourceBytes)

  await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  expect(await readFile(operationPath)).toEqual(sourceBytes)
  await expect(writeOperationRecord(projectRoot, normalized)).rejects.toMatchObject({
    code: ProjectVersioningErrorCodes.gitUnavailable
  })
  expect(await readFile(operationPath)).toEqual(sourceBytes)
  expect(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')).toBe(
    '{"formatVersion":1}'
  )
  expect(await readdir(join(projectRoot, '.git', 'opengalgame', 'legacy-operations'))).toHaveLength(
    1
  )

  await rm(archiveDirectory, { recursive: true, force: true })
  await writeOperationRecord(projectRoot, normalized)
  const rewritten = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>
  expect(rewritten).toMatchObject({ operationId: 'op-current', formatVersion: 1 })
  expect(Object.hasOwn(rewritten, 'rollbackIndexBytesBase64')).toBe(false)
})

it('legacy-operations 是链接时读取不丢源，覆盖写在归档前拒绝', async () => {
  const projectRoot = await temporaryProject('opengalgame-r32-link-')
  const outside = await mkdtemp(join(tmpdir(), 'opengalgame-r32-link-target-'))
  temporaryRoots.push(outside)
  await mkdir(join(projectRoot, '.git', 'opengalgame'), { recursive: true })
  await symlink(
    outside,
    join(projectRoot, '.git', 'opengalgame', 'legacy-operations'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const { path: operationPath, bytes: sourceBytes } = await writeLegacyRecord(projectRoot)
  const read = await readOperationRecord(projectRoot, 'op-current')
  expect(read.kind).toBe('ok')
  if (read.kind !== 'ok') throw new Error('链接故障下应保留旧读行为')
  expect(await readFile(operationPath)).toEqual(sourceBytes)
  await expect(writeOperationRecord(projectRoot, read.record)).rejects.toMatchObject({
    code: ProjectVersioningErrorCodes.gitUnavailable
  })
  expect(await readFile(operationPath)).toEqual(sourceBytes)
})

it('归一 rename 失败不丢源，移除故障后复用归档重试成功', async () => {
  const projectRoot = await temporaryProject('opengalgame-r32-rename-')
  const { path: operationPath, bytes: sourceBytes } = await writeLegacyRecord(projectRoot)
  renameControl.failTo = operationPath
  await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  expect(await readFile(operationPath)).toEqual(sourceBytes)
  const archiveDirectory = await archiveDirectoryFor(projectRoot)
  expect(await readdir(join(projectRoot, '.git', 'opengalgame', 'operations'))).not.toContainEqual(
    expect.stringContaining('.opengalgame-tmp-')
  )

  renameControl.failTo = null
  await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  const normalized = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>
  expect(Object.hasOwn(normalized, 'rollbackIndexBytesBase64')).toBe(false)
  expect(await readdir(join(projectRoot, '.git', 'opengalgame', 'legacy-operations'))).toHaveLength(
    1
  )
  expect(archiveDirectory).toBeTruthy()
})

it('写前预读失败保持写错误码且不覆盖 legacy 源，解除后重试成功', async () => {
  const projectRoot = await temporaryProject('opengalgame-r32-read-fail-')
  const { path: operationPath, bytes: sourceBytes } = await writeLegacyRecord(projectRoot)
  const { rollbackIndexBytesBase64, ...currentRecord } = legacyRecord({
    rollbackIndexBytesBase64: Buffer.from('legacy-index-bytes').toString('base64')
  })
  void rollbackIndexBytesBase64
  readControl.failTo = operationPath
  await expect(
    writeOperationRecord(projectRoot, currentRecord as unknown as OperationRecord)
  ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.gitUnavailable })
  readControl.failTo = null
  expect(await readFile(operationPath)).toEqual(sourceBytes)

  await writeOperationRecord(projectRoot, currentRecord as unknown as OperationRecord)
  const normalized = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>
  expect(normalized).toMatchObject({ operationId: 'op-current', formatVersion: 1 })
  expect(Object.hasOwn(normalized, 'rollbackIndexBytesBase64')).toBe(false)
})

it('发布后复验失败保留已发布批次，解除故障后复用同一归档且源不丢', async () => {
  const projectRoot = await temporaryProject('opengalgame-r32-post-publish-')
  const { path: operationPath, bytes: sourceBytes } = await writeLegacyRecord(projectRoot)
  readControl.manifestReads = 0
  readControl.failManifestRead = 2

  const firstRead = await readOperationRecord(projectRoot, 'op-current')
  expect(firstRead.kind).toBe('ok')
  expect(await readFile(operationPath)).toEqual(sourceBytes)
  readControl.failManifestRead = null

  const archiveRoot = join(projectRoot, '.git', 'opengalgame', 'legacy-operations')
  const archiveNames = await readdir(archiveRoot)
  expect(archiveNames).toHaveLength(1)
  const archiveDirectory = join(archiveRoot, archiveNames[0]!)
  const manifest = JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')) as {
    formatVersion: number
    kind: string
    batchId: string
  }
  expect(manifest).toMatchObject({
    formatVersion: 1,
    kind: 'legacy-data-backup',
    batchId: archiveNames[0]
  })
  const archivedPath = join(
    archiveDirectory,
    'files/project-0/.git/opengalgame/operations/op-current.json'
  )
  expect(await readFile(archivedPath)).toEqual(sourceBytes)

  await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toMatchObject({
    kind: 'ok'
  })
  const normalized = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>
  expect(normalized).toMatchObject({ operationId: 'op-current', formatVersion: 1 })
  expect(Object.hasOwn(normalized, 'rollbackIndexBytesBase64')).toBe(false)
  expect(await readdir(archiveRoot)).toHaveLength(1)
  expect(await readFile(archivedPath)).toEqual(sourceBytes)
})
