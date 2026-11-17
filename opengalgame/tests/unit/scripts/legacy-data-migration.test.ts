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
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { readOperationRecord } from '@infrastructure/git/transaction/OperationRecord'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import { SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION } from '@infrastructure/scene-generation/execution/SceneGenerationExecutionDocument'
import { LocalSceneCanvasArrangementInspectionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementInspectionGatewayImpl'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import {
  PROJECT_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema as legacyV3DocumentSchema
} from '@infrastructure/scene-canvas/migration/legacy/documents/LegacySceneCanvasArrangementDocument'
import { SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION } from '@infrastructure/scene-canvas/migration/legacy/documents/SceneCanvasArrangementV4Document'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

async function writeAt(
  root: string,
  relativePath: string,
  content: string | Uint8Array
): Promise<string> {
  const target = join(root, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

async function writeProjectManifest(root: string): Promise<void> {
  await writeAt(
    root,
    '.opengalgame/manifest.json',
    JSON.stringify({ formatVersion: 2, projectId: 'project-1' })
  )
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function currentCanvasDocument(): Record<string, unknown> {
  return {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-current',
    viewport: { x: 1, y: 2, zoom: 1.5 },
    cards: [
      {
        kind: 'document',
        cardId: 'card-doc',
        sourceId: 'source-doc',
        title: '当前标题',
        summary: '当前摘要',
        usage: { characterId: 'char-1', locationId: 'room-1', targetIds: [] },
        layout: { x: 0, y: 0, width: 100, height: 80 }
      }
    ],
    relations: []
  }
}

function legacyV4CanvasDocument(): Record<string, unknown> {
  return {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-v4',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'card-v4',
        sourceId: 'source-v4',
        title: '旧 v4 标题',
        summary: '旧 v4 摘要',
        layout: { x: 10, y: 20, width: 120, height: 90 }
      }
    ],
    relations: []
  }
}

function legacyV3CanvasDocument(): Record<string, unknown> {
  return {
    formatVersion: PROJECT_ARRANGEMENT_FORMAT_VERSION,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-v3',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'card-v3',
        sourceId: 'source-v3',
        title: '旧 v3 标题',
        summary: '旧 v3 摘要',
        usage: { characterId: 'char-v3', targetIds: ['target-v3'] },
        layout: { x: 5, y: 6, width: 100, height: 80 }
      }
    ],
    relations: []
  }
}

function currentExecution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      canvasId: 'canvas-current',
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
    baseline: { commitId: 'base-commit', affectedFiles: [], lockState: 'unlocked' },
    state: 'pending',
    step: 'preparing',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    ...overrides
  }
}

function legacyExecutionWithoutTime(): Record<string, unknown> {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-legacy',
    threadId: 'thread-legacy',
    branchId: 'branch-legacy',
    fingerprint: 'fingerprint-legacy',
    state: 'succeeded',
    inputSnapshot: { prompts: [{ id: 'story', sourceId: 'story', body: '旧正文' }] }
  }
}

function operationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        intendedDigest: sha256('intended-bytes'),
        originalStageOid: null
      }
    ],
    indexBytesBase64: indexBytes.toString('base64'),
    indexDigest: sha256(indexBytes),
    ...overrides
  }
}

async function writeExecutions(
  stateRoot: string,
  version: number,
  executions: readonly unknown[]
): Promise<void> {
  await writeAt(
    stateRoot,
    'scene-generation/projects/project-1/executions.json',
    JSON.stringify({ version, executions })
  )
}

const CLI_PATH = fileURLToPath(
  new URL('../../../scripts/legacy-data-migration/cli.cjs', import.meta.url)
)
const execFileAsync = promisify(execFile)

type CliManifestEntry = {
  family: string
  originalPath: string
  backupPath: string
  sizeBytes: number
  sha256: string
  modifiedAt: string
  backedUpAt: string
}

type CliManifest = {
  formatVersion: number
  kind: string
  batchId: string
  toolVersion: string
  createdAt: string
  backupRoot: string
  scope: {
    stateRoot: string | null
    projectRoots: string[]
    visitedProjects: string[]
    unvisitedProjects: { known: boolean; count: number | null; note: string }
  }
  entries: CliManifestEntry[]
}

type MigrationSource = {
  root: string
  stateRoot: string
  projectRoot: string
  canvasPath: string
  executionPath: string
  operationPath: string
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path))
}

async function fileHashes(paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => sha256File(path)))
}

async function runCli(args: readonly string[]): Promise<{
  code: number
  json: Record<string, unknown>
  stdout: string
  stderr: string
}> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd: join(dirname(CLI_PATH), '..', '..'),
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

async function seedMigrationSource(): Promise<MigrationSource> {
  const root = await temporaryRoot('opengalgame-r27-cli-')
  const stateRoot = join(root, 'state')
  const projectRoot = join(root, 'project')
  await writeProjectManifest(projectRoot)
  const canvasPath = await writeAt(
    projectRoot,
    arrangementPath('scene-1', 'canvas-current'),
    JSON.stringify(currentCanvasDocument())
  )
  await writeExecutions(stateRoot, SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION, [
    currentExecution({
      createdAt: '2026-11-14T01:00:00.000Z',
      updatedAt: '2026-11-14T02:00:00.000Z'
    })
  ])
  const operationPath = await writeAt(
    projectRoot,
    '.git/opengalgame/operations/op-current.json',
    JSON.stringify(
      operationRecord({
        rollbackIndexBytesBase64: Buffer.from('rollback-index-bytes').toString('base64')
      })
    )
  )
  return {
    root,
    stateRoot,
    projectRoot,
    canvasPath,
    executionPath: join(
      stateRoot,
      'scene-generation/projects/project-1/executions.json'
    ),
    operationPath
  }
}

async function readCliManifest(path: string): Promise<CliManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as CliManifest
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

async function backupSource(
  source: MigrationSource,
  backupParent: string,
  batchId: string
): Promise<{ manifestPath: string; backupRoot: string; json: Record<string, unknown> }> {
  const result = await runCli([
    'backup',
    '--state-root',
    source.stateRoot,
    '--project-root',
    source.projectRoot,
    '--backup-root',
    backupParent,
    '--batch-id',
    batchId,
    '--apply'
  ])
  expect(result.code).toBe(0)
  expect(result.json.dryRun).toBe(false)
  const backupRoot = join(await realpath(backupParent), batchId)
  return { manifestPath: join(backupRoot, 'manifest.json'), backupRoot, json: result.json }
}

describe('R27 基线：新用户空初始化', () => {
  it('空状态根与空工程不产生记录、画布或操作事实，也不伪造目录内容', async () => {
    const root = await temporaryRoot('opengalgame-r27-empty-')
    const stateRoot = join(root, 'state')
    const projectRoot = join(root, 'project')
    await writeProjectManifest(projectRoot)

    const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
    await expect(
      repository.listSceneExecutions({ projectId: 'project-1', sceneId: 'scene-1', limit: 20 })
    ).resolves.toEqual([])
    await expect(
      repository.readExecution({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-missing'
      })
    ).resolves.toBeNull()
    await expect(
      repository.findLatestSceneExecution('project-1', 'scene-1')
    ).resolves.toBeNull()

    await expect(
      new LocalSceneCanvasArrangementInspectionGatewayImpl().inspectSceneCanvasArrangements({
        projectId: 'project-1',
        location: { directory: projectRoot }
      })
    ).resolves.toEqual({
      projectId: 'project-1',
      canvasArrangementFormatSupported: true,
      arrangements: []
    })

    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await expect(readOperationRecord(projectRoot, 'operation-missing')).resolves.toEqual({
      kind: 'missing'
    })
  })
})

describe('R27 基线：当前格式正常', () => {
  it('当前画布 v5、执行文档 v7 与操作记录 formatVersion 1 均按当前读取器可读', async () => {
    const root = await temporaryRoot('opengalgame-r27-current-')
    const stateRoot = join(root, 'state')
    const projectRoot = join(root, 'project')
    await writeProjectManifest(projectRoot)

    const canvas = currentCanvasDocument()
    await writeAt(
      projectRoot,
      arrangementPath('scene-1', 'canvas-current'),
      JSON.stringify(canvas)
    )

    const inspection =
      await new LocalSceneCanvasArrangementInspectionGatewayImpl().inspectSceneCanvasArrangements({
        projectId: 'project-1',
        location: { directory: projectRoot }
      })
    expect(inspection.canvasArrangementFormatSupported).toBe(true)
    expect(inspection.arrangements).toHaveLength(1)
    const inspectionItem = inspection.arrangements[0]
    if (inspectionItem?.availability !== 'present') throw new Error('当前画布未被识别为可用')
    expect(inspectionItem.arrangement).toMatchObject({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-current',
      viewport: { x: 1, y: 2, zoom: 1.5 }
    })
    expect(inspectionItem.arrangement.cards[0]).toMatchObject({
      kind: 'document',
      cardId: 'card-doc',
      sourceId: 'source-doc',
      title: '当前标题',
      summary: '当前摘要',
      usage: { characterId: 'char-1', locationId: 'room-1', targetIds: [] }
    })

    const execution = currentExecution({
      createdAt: '2026-11-14T01:00:00.000Z',
      updatedAt: '2026-11-14T02:00:00.000Z'
    })
    await writeExecutions(stateRoot, SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION, [execution])
    const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
    await expect(
      repository.readExecution({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-current'
      })
    ).resolves.toMatchObject({
      operationId: 'operation-current',
      createdAt: '2026-11-14T01:00:00.000Z',
      updatedAt: '2026-11-14T02:00:00.000Z'
    })

    const record = operationRecord()
    await writeAt(
      projectRoot,
      '.git/opengalgame/operations/op-current.json',
      JSON.stringify(record)
    )
    const read = await readOperationRecord(projectRoot, 'op-current')
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') throw new Error('当前操作记录未被识别为可用')
    expect(read.record).toMatchObject({
      formatVersion: 1,
      operationId: 'op-current',
      phase: 'published'
    })
    expect(Buffer.from(read.record.indexBytesBase64, 'base64').toString('utf8')).toBe(
      'index-bytes'
    )
  })
})

describe('R27 基线：旧数据读取', () => {
  it('旧 v3 由 legacy schema 保留业务字段，产品检查对旧 v3/v4 明确不支持', async () => {
    const root = await temporaryRoot('opengalgame-r27-legacy-canvas-')
    const projectRoot = join(root, 'project')
    await writeProjectManifest(projectRoot)

    const v3 = legacyV3CanvasDocument()
    const parsedV3 = legacyV3DocumentSchema.safeParse(v3)
    expect(parsedV3.success).toBe(true)
    if (!parsedV3.success) throw new Error('旧 v3 文档未被 legacy schema 接受')
    expect(parsedV3.data.cards[0]).toMatchObject({
      cardId: 'card-v3',
      title: '旧 v3 标题',
      summary: '旧 v3 摘要',
      usage: { characterId: 'char-v3', targetIds: ['target-v3'] }
    })
    await writeAt(
      projectRoot,
      arrangementPath('scene-1', 'canvas-v3'),
      JSON.stringify(v3)
    )

    const v4 = legacyV4CanvasDocument()
    await writeAt(
      projectRoot,
      arrangementPath('scene-1', 'canvas-v4'),
      JSON.stringify(v4)
    )

    const inspection =
      await new LocalSceneCanvasArrangementInspectionGatewayImpl().inspectSceneCanvasArrangements({
        projectId: 'project-1',
        location: { directory: projectRoot }
      })
    expect(inspection.canvasArrangementFormatSupported).toBe(false)
    expect(inspection.arrangements).toEqual([])
  })

  it('有持久时间的旧执行文档补齐步骤并保留既有时间，不估算时间', async () => {
    const root = await temporaryRoot('opengalgame-r27-legacy-execution-')
    const stateRoot = join(root, 'state')
    const stored = currentExecution({
      phase: 'generating',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T01:00:00.000Z'
    })
    delete stored.step
    await writeExecutions(stateRoot, 1, [stored])

    const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
    const loaded = await repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-current'
    })
    expect(loaded).toMatchObject({
      operationId: 'operation-current',
      step: 'generating',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T01:00:00.000Z'
    })
  })

  it('操作记录旧可选字段由首访读取迁移归档，当前记录不再保留旧字段', async () => {
    const root = await temporaryRoot('opengalgame-r27-legacy-operation-')
    const projectRoot = join(root, 'project')
    await mkdir(join(projectRoot, '.git'), { recursive: true })

    const rollbackBytes = Buffer.from('rollback-index-bytes')
    const record = operationRecord({
      rollbackIndexBytesBase64: rollbackBytes.toString('base64')
    })
    const operationPath = await writeAt(
      projectRoot,
      '.git/opengalgame/operations/op-current.json',
      JSON.stringify(record)
    )
    const sourceBytes = await readFile(operationPath)

    const read = await readOperationRecord(projectRoot, 'op-current')
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') throw new Error('含旧字段的操作记录未被识别为可用')
    expect(Object.hasOwn(read.record, 'rollbackIndexBytesBase64')).toBe(false)

    const normalized = JSON.parse(await readFile(operationPath, 'utf8')) as Record<string, unknown>
    expect(normalized).toMatchObject({ formatVersion: 1, operationId: 'op-current' })
    expect(Object.hasOwn(normalized, 'rollbackIndexBytesBase64')).toBe(false)

    const archiveRoot = join(projectRoot, '.git', 'opengalgame', 'legacy-operations')
    const archiveNames = await readdir(archiveRoot)
    expect(archiveNames).toHaveLength(1)
    const archiveDirectory = join(archiveRoot, archiveNames[0]!)
    const manifest = JSON.parse(
      await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')
    ) as {
      formatVersion: number
      kind: string
      batchId: string
      toolVersion: string
      backupRoot: string
      scope: {
        projectRoots: string[]
        visitedProjects: string[]
        unvisitedProjects: { known: boolean; count: number | null; note: string }
      }
      entries: Array<{
        originalPath: string
        backupPath: string
        sizeBytes: number
        sha256: string
      }>
    }
    expect(manifest).toMatchObject({
      formatVersion: 1,
      kind: 'legacy-data-backup',
      batchId: archiveNames[0],
      toolVersion: 'opengalgame-r32/1',
      backupRoot: archiveDirectory,
      scope: {
        projectRoots: [await realpath(projectRoot)],
        visitedProjects: [await realpath(projectRoot)],
        unvisitedProjects: { known: false, count: null }
      }
    })
    expect(manifest.scope.unvisitedProjects.note).toContain('未访问')
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        originalPath: operationPath,
        backupPath: 'files/project-0/.git/opengalgame/operations/op-current.json',
        sizeBytes: sourceBytes.byteLength,
        sha256: sha256(sourceBytes)
      })
    ])
    const archivedBytes = await readFile(
      join(archiveDirectory, 'files/project-0/.git/opengalgame/operations/op-current.json')
    )
    expect(archivedBytes).toEqual(sourceBytes)

    const report = JSON.parse(
      await readFile(join(archiveDirectory, 'report.json'), 'utf8')
    ) as {
      field: {
        name: string
        disposition: string
        usedByRollback: boolean
        currentConsumers: string[]
        valueSha256: string
        valueByteLength: number
      }
      scope: { unvisitedProjects: { known: boolean; count: number | null } }
    }
    expect(report.field).toMatchObject({
      name: 'rollbackIndexBytesBase64',
      disposition: 'dropped-unused',
      usedByRollback: false,
      currentConsumers: [],
      valueSha256: sha256(rollbackBytes),
      valueByteLength: rollbackBytes.byteLength
    })
    expect(report.scope.unvisitedProjects).toMatchObject({ known: false, count: null })
  })

  it('含不可解码旧可选字段的操作记录整体记为 damaged', async () => {
    const root = await temporaryRoot('opengalgame-r27-operation-damaged-')
    const projectRoot = join(root, 'project')
    await mkdir(join(projectRoot, '.git'), { recursive: true })
    const record = operationRecord({ rollbackIndexBytesBase64: '***not-base64***' })
    await writeAt(
      projectRoot,
      '.git/opengalgame/operations/op-current.json',
      JSON.stringify(record)
    )
    await expect(readOperationRecord(projectRoot, 'op-current')).resolves.toEqual({
      kind: 'damaged'
    })
  })
})

describe('R27 基线：不可续跑权限', () => {
  it('缺记录时间的 legacy 记录归档后不可恢复、不进入场景历史，当前记录可见集合不变', async () => {
    const root = await temporaryRoot('opengalgame-r27-not-resumable-')
    const stateRoot = join(root, 'state')
    const legacy = legacyExecutionWithoutTime()
    const current = currentExecution({
      createdAt: '2026-11-14T01:00:00.000Z',
      updatedAt: '2026-11-14T02:00:00.000Z'
    })
    await writeExecutions(stateRoot, 1, [legacy, current])
    const path = join(
      stateRoot,
      'scene-generation/projects/project-1/executions.json'
    )
    const before = await readFile(path)

    const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
    await expect(
      repository.readExecution({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-legacy'
      })
    ).resolves.toBeNull()
    await expect(
      repository.readExecution({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-current'
      })
    ).resolves.toMatchObject({ operationId: 'operation-current' })

    const visible = await repository.listSceneExecutions({
      projectId: 'project-1',
      sceneId: 'scene-1',
      limit: 20
    })
    expect(visible.map((execution) => execution.operationId)).toEqual(['operation-current'])
    await expect(repository.findLatestSceneExecution('project-1', 'scene-1')).resolves.toMatchObject(
      { operationId: 'operation-current' }
    )
    await expect(
      repository.listThread({
        projectId: 'project-1',
        sceneId: 'scene-1',
        threadId: 'thread-legacy'
      })
    ).resolves.toEqual([])
    await expect(
      repository.findActiveExecution({
        projectId: 'project-1',
        sceneId: 'scene-1',
        threadId: 'thread-legacy'
      })
    ).resolves.toBeNull()

    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      version: number
      executions: Array<{ operationId: string }>
    }
    expect(persisted.version).toBe(7)
    expect(persisted.executions.map((execution) => execution.operationId)).toEqual([
      'operation-current'
    ])
    const archiveDirectory = join(
      stateRoot,
      'scene-generation/projects/project-1/legacy-executions',
      createHash('sha256').update(before).digest('hex')
    )
    expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(before)
    const manifest = JSON.parse(
      await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')
    ) as { counts: Record<string, number>; legacyRecords: Array<Record<string, unknown>> }
    expect(manifest.counts).toEqual({ total: 2, current: 1, legacy: 1 })
    expect(manifest.legacyRecords).toEqual([
      expect.objectContaining({
        operationId: 'operation-legacy',
        hasCreatedAt: false,
        hasUpdatedAt: false,
        hasTimeline: false,
        reason: 'missing-record-time'
      })
    ])
  })
})

describe('R27 CLI：inventory/backup/verify/restore', () => {
  it('inventory 只读报告三族、scope 与操作旧字段，不修改源文件', async () => {
    const source = await seedMigrationSource()
    const sourcePaths = [source.canvasPath, source.executionPath, source.operationPath]
    const before = await fileHashes(sourcePaths)

    const result = await runCli([
      'inventory',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ])
    expect(result.code).toBe(0)
    const inventory = result.json as {
      command: string
      dryRun: boolean
      scope: {
        stateRoot: string | null
        projectRoots: string[]
        visitedProjects: string[]
        unvisitedProjects: { known: boolean; count: number | null; note: string }
      }
      families: {
        canvas: Array<Record<string, unknown>>
        execution: Array<{ classification: string; records: Array<Record<string, unknown>> }>
        operation: Array<{ classification: string; rollbackIndex: Record<string, unknown> }>
      }
      summary: { totalFiles: number }
    }
    const stateReal = await realpath(source.stateRoot)
    const projectReal = await realpath(source.projectRoot)
    expect(inventory.command).toBe('inventory')
    expect(inventory.dryRun).toBe(true)
    expect(inventory.scope).toMatchObject({
      stateRoot: stateReal,
      projectRoots: [projectReal],
      visitedProjects: [projectReal],
      unvisitedProjects: { known: false, count: null }
    })
    expect(inventory.scope.unvisitedProjects.note).toContain('未访问')
    expect(inventory.summary.totalFiles).toBe(3)
    expect(inventory.families.canvas).toHaveLength(1)
    expect(inventory.families.canvas[0]).toMatchObject({
      classification: 'current',
      formatVersion: 5
    })
    expect(inventory.families.execution).toHaveLength(1)
    expect(inventory.families.execution[0]).toMatchObject({
      classification: 'current',
      formatVersion: 7,
      records: [{ classification: 'current', resumable: null }]
    })
    expect(inventory.families.operation).toHaveLength(1)
    expect(inventory.families.operation[0]).toMatchObject({
      classification: 'current',
      formatVersion: 1,
      rollbackIndex: {
        source: {
          schema: 'operationRecordSchema',
          field: 'rollbackIndexBytesBase64',
          optional: true
        },
        present: true,
        decodable: true,
        digestFieldPresent: false,
        writtenByCurrentTool: false,
        usedByRollback: false,
        classification: 'legacy-optional-unused',
        readImpact: 'none'
      }
    })
    expect(inventory.families.operation[0]?.rollbackIndex.sha256).toBe(
      sha256(Buffer.from('rollback-index-bytes'))
    )
    expect(await fileHashes(sourcePaths)).toEqual(before)
  })

  it('backup 默认 dry-run 不写；--apply 写 manifest，verify 通过', async () => {
    const source = await seedMigrationSource()
    const sourcePaths = [source.canvasPath, source.executionPath, source.operationPath]
    const before = await fileHashes(sourcePaths)
    const backupParent = await temporaryRoot('opengalgame-r27-cli-backup-')
    const backupReal = await realpath(backupParent)
    const batchId = 'batch-cli'
    const baseArgs = [
      'backup',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot,
      '--backup-root',
      backupParent,
      '--batch-id',
      batchId
    ]

    const dry = await runCli(baseArgs)
    expect(dry.code).toBe(0)
    expect(dry.json).toMatchObject({ command: 'backup', dryRun: true, batchId })
    expect(dry.json.entries).toHaveLength(3)
    expect(await readdir(backupParent)).toEqual([])

    const applied = await runCli([...baseArgs, '--apply'])
    expect(applied.code).toBe(0)
    expect(applied.json.dryRun).toBe(false)
    const manifestPath = join(backupReal, batchId, 'manifest.json')
    expect(applied.json.manifestPath).toBe(manifestPath)
    const manifest = await readCliManifest(manifestPath)
    expect(manifest).toMatchObject({
      formatVersion: 1,
      kind: 'legacy-data-backup',
      batchId,
      toolVersion: '1',
      backupRoot: join(backupReal, batchId)
    })
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'formatVersion',
        'kind',
        'batchId',
        'toolVersion',
        'createdAt',
        'backupRoot',
        'scope',
        'entries'
      ].sort()
    )
    expect(manifest.scope).toMatchObject({
      stateRoot: await realpath(source.stateRoot),
      projectRoots: [await realpath(source.projectRoot)],
      unvisitedProjects: { known: false, count: null }
    })
    expect(manifest.entries).toHaveLength(3)
    const originals = await Promise.all(
      sourcePaths.map(async (path) => realpath(path))
    )
    expect(manifest.entries.map((entry) => entry.originalPath).sort()).toEqual(
      [...originals].sort()
    )
    for (const entry of manifest.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          'family',
          'originalPath',
          'backupPath',
          'sizeBytes',
          'sha256',
          'modifiedAt',
          'backedUpAt'
        ].sort()
      )
      expect(entry.family).toBeTypeOf('string')
      expect(Number.isNaN(Date.parse(entry.modifiedAt))).toBe(false)
      expect(Number.isNaN(Date.parse(entry.backedUpAt))).toBe(false)
      const backupFile = join(manifest.backupRoot, entry.backupPath)
      const bytes = await readFile(backupFile)
      expect(bytes.byteLength).toBe(entry.sizeBytes)
      expect(sha256(bytes)).toBe(entry.sha256)
    }

    const verified = await runCli(['verify', '--manifest', manifestPath])
    expect(verified.code).toBe(0)
    expect(verified.json).toMatchObject({
      ok: true,
      integrityOk: true,
      readable: true,
      formatOk: true,
      bytesOnly: false,
      summary: { entries: 3, current: 3, legacy: 0, unreadable: 0 }
    })
    expect(await fileHashes(sourcePaths)).toEqual(before)
  })

  it('restore 默认 dry-run 不写；--apply 先全校验再恢复且不删原件', async () => {
    const source = await seedMigrationSource()
    const sourcePaths = [source.canvasPath, source.executionPath, source.operationPath]
    const original = await fileHashes(sourcePaths)
    const backupParent = await temporaryRoot('opengalgame-r27-cli-restore-')
    const { manifestPath } = await backupSource(source, backupParent, 'batch-restore')
    const restoreArgs = [
      'restore',
      '--manifest',
      manifestPath,
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ]

    await writeFile(source.canvasPath, 'changed canvas')
    await writeFile(source.executionPath, 'changed execution')
    await writeFile(source.operationPath, 'changed operation')
    const changed = await fileHashes(sourcePaths)

    const dry = await runCli(restoreArgs)
    expect(dry.code).toBe(0)
    expect(dry.json).toMatchObject({ command: 'restore', dryRun: true })
    expect(dry.json.wouldRestore).toHaveLength(3)
    expect(await fileHashes(sourcePaths)).toEqual(changed)

    const applied = await runCli([...restoreArgs, '--apply'])
    expect(applied.code).toBe(0)
    expect(applied.json).toMatchObject({
      command: 'restore',
      dryRun: false,
      readable: true,
      bytesOnly: false
    })
    expect(applied.json.restored).toHaveLength(3)
    expect(await fileHashes(sourcePaths)).toEqual(original)
    await expect(readFile(manifestPath, 'utf8')).resolves.toContain('legacy-data-backup')
  })

  it('verify/restore 拒绝损坏摘要、备份路径跳转与越界 scope/originalPath', async () => {
    const source = await seedMigrationSource()
    const sourcePaths = [source.canvasPath, source.executionPath, source.operationPath]
    const before = await fileHashes(sourcePaths)
    const backupParent = await temporaryRoot('opengalgame-r27-cli-corrupt-')
    const { manifestPath } = await backupSource(source, backupParent, 'batch-corrupt')
    const validText = await readFile(manifestPath, 'utf8')
    const restoreArgs = [
      'restore',
      '--manifest',
      manifestPath,
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot,
      '--apply'
    ]

    const corrupted = JSON.parse(validText) as CliManifest
    corrupted.entries[0]!.sha256 = '0'.repeat(64)
    await writeFile(manifestPath, JSON.stringify(corrupted))
    const verifyCorrupted = await runCli(['verify', '--manifest', manifestPath])
    expect(verifyCorrupted.code).toBe(3)
    expect(verifyCorrupted.json).toMatchObject({ ok: false, code: 3 })
    const restoreCorrupted = await runCli(restoreArgs)
    expect(restoreCorrupted.code).toBe(3)
    expect(await fileHashes(sourcePaths)).toEqual(before)

    const traversal = JSON.parse(validText) as CliManifest
    traversal.entries[0]!.backupPath = '../escape'
    await writeFile(manifestPath, JSON.stringify(traversal))
    const verifyTraversal = await runCli(['verify', '--manifest', manifestPath])
    expect(verifyTraversal.code).toBe(3)

    const redirected = JSON.parse(validText) as CliManifest
    const outside = join(source.root, 'outside-restore.txt')
    redirected.scope.projectRoots = [source.root]
    redirected.entries[0]!.originalPath = outside
    await writeFile(manifestPath, JSON.stringify(redirected))
    await writeFile(outside, 'untouched')
    const restoreRedirected = await runCli(restoreArgs)
    expect(restoreRedirected.code).toBe(3)
    await expect(readFile(outside, 'utf8')).resolves.toBe('untouched')
    expect(await fileHashes(sourcePaths)).toEqual(before)
  })

  it('拒绝备份根位于源根内、相对根与无显式根', async () => {
    const source = await seedMigrationSource()
    const nested = join(source.projectRoot, 'backup-root')
    await mkdir(nested)

    const nestedResult = await runCli([
      'backup',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot,
      '--backup-root',
      nested,
      '--apply'
    ])
    expect(nestedResult.code).toBe(2)
    expect(await readdir(nested)).toEqual([])

    const relativeRoot = await runCli(['inventory', '--state-root', 'relative/path'])
    expect(relativeRoot.code).toBe(2)

    const noRoots = await runCli(['backup', '--backup-root', nested, '--apply'])
    expect(noRoots.code).toBe(2)

    const restoreWithoutRoots = await runCli([
      'restore',
      '--manifest',
      join(nested, 'missing.json')
    ])
    expect(restoreWithoutRoots.code).toBe(2)
  })

  it('rollbackIndexBytesBase64:null 判 damaged，verify 显式 bytes-only，恢复需 --allow-unreadable', async () => {
    const source = await seedMigrationSource()
    const sourcePaths = [source.canvasPath, source.executionPath, source.operationPath]
    await writeFile(
      source.operationPath,
      JSON.stringify(operationRecord({ rollbackIndexBytesBase64: null }))
    )
    const before = await fileHashes(sourcePaths)

    const inventoryResult = await runCli([
      'inventory',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ])
    expect(inventoryResult.code).toBe(0)
    const inventory = inventoryResult.json as {
      families: {
        operation: Array<{ classification: string; rollbackIndex: Record<string, unknown> }>
      }
    }
    expect(inventory.families.operation[0]).toMatchObject({
      classification: 'unreadable',
      rollbackIndex: {
        source: {
          schema: 'operationRecordSchema',
          field: 'rollbackIndexBytesBase64',
          optional: true
        },
        present: true,
        decodable: false,
        readImpact: 'damaged-record',
        classification: 'legacy-optional-unused'
      }
    })

    const backupParent = await temporaryRoot('opengalgame-r27-cli-unreadable-')
    const { manifestPath } = await backupSource(source, backupParent, 'batch-unreadable')
    const deniedVerify = await runCli(['verify', '--manifest', manifestPath])
    expect(deniedVerify.code).toBe(3)
    const verified = await runCli([
      'verify',
      '--manifest',
      manifestPath,
      '--allow-unreadable'
    ])
    expect(verified.code).toBe(0)
    expect(verified.json).toMatchObject({
      ok: true,
      integrityOk: true,
      readable: false,
      formatOk: false,
      bytesOnly: true,
      contract: 'bytes-only',
      summary: { unreadable: 1 }
    })
    const restoreArgs = [
      'restore',
      '--manifest',
      manifestPath,
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ]
    const denied = await runCli([...restoreArgs, '--apply'])
    expect(denied.code).toBe(3)
    expect(await fileHashes(sourcePaths)).toEqual(before)

    const allowed = await runCli([...restoreArgs, '--allow-unreadable', '--apply'])
    expect(allowed.code).toBe(0)
    expect(allowed.json).toMatchObject({
      ok: true,
      dryRun: false,
      readable: false,
      bytesOnly: true
    })
    expect(allowed.json.restored).toHaveLength(3)
    expect(await fileHashes(sourcePaths)).toEqual(before)
  })

  it('按真实 schema 分类：v1 当前记录为 current，v5 缺 cards/操作缺 phase 为 unreadable', async () => {
    const source = await seedMigrationSource()
    await writeExecutions(source.stateRoot, 1, [
      currentExecution({
        createdAt: '2026-11-14T01:00:00.000Z',
        updatedAt: '2026-11-14T02:00:00.000Z'
      })
    ])
    const brokenCanvas = currentCanvasDocument()
    delete brokenCanvas.cards
    await writeFile(source.canvasPath, JSON.stringify(brokenCanvas))
    const brokenOperation = operationRecord()
    delete brokenOperation.phase
    await writeFile(source.operationPath, JSON.stringify(brokenOperation))

    const result = await runCli([
      'inventory',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ])
    expect(result.code).toBe(0)
    const inventory = result.json as {
      families: {
        canvas: Array<{ classification: string }>
        execution: Array<{ classification: string; records: Array<Record<string, unknown>> }>
        operation: Array<{ classification: string }>
      }
    }
    expect(inventory.families.execution[0]).toMatchObject({
      classification: 'current',
      records: [{ classification: 'current', resumable: null }]
    })
    expect(inventory.families.canvas[0]).toMatchObject({ classification: 'unreadable' })
    expect(inventory.families.operation[0]).toMatchObject({ classification: 'unreadable' })
  })

  it('拒绝 . 别名重复目标与 family/源路径/namespace 不一致', async () => {
    const source = await seedMigrationSource()
    const sourcePaths = [source.canvasPath, source.executionPath, source.operationPath]
    const before = await fileHashes(sourcePaths)
    const backupParent = await temporaryRoot('opengalgame-r27-cli-alias-')
    const { manifestPath } = await backupSource(source, backupParent, 'batch-alias')
    const validText = await readFile(manifestPath, 'utf8')
    const restoreArgs = [
      'restore',
      '--manifest',
      manifestPath,
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot,
      '--apply'
    ]

    const aliased = JSON.parse(validText) as CliManifest
    const canvasEntry = aliased.entries.find((entry) => entry.family === 'canvas')
    const operationEntry = aliased.entries.find((entry) => entry.family === 'operation')
    if (!canvasEntry || !operationEntry) throw new Error('备份缺少 canvas/operation 条目')
    operationEntry.originalPath = `${dirname(canvasEntry.originalPath)}${sep}.${sep}${basename(canvasEntry.originalPath)}`
    await writeFile(manifestPath, JSON.stringify(aliased))
    const aliasResult = await runCli(restoreArgs)
    expect(aliasResult.code).toBe(3)
    expect(await fileHashes(sourcePaths)).toEqual(before)

    const namespaceTamper = JSON.parse(validText) as CliManifest
    const namespaceEntry = namespaceTamper.entries.find((entry) => entry.family === 'canvas')
    if (!namespaceEntry) throw new Error('备份缺少 canvas 条目')
    namespaceEntry.backupPath = namespaceEntry.backupPath.replace(
      /^files\/project-\d+\//u,
      'files/state/'
    )
    await writeFile(manifestPath, JSON.stringify(namespaceTamper))
    const namespaceResult = await runCli(['verify', '--manifest', manifestPath])
    expect(namespaceResult.code).toBe(3)

    const familyTamper = JSON.parse(validText) as CliManifest
    const operationTamper = familyTamper.entries.find((entry) => entry.family === 'operation')
    if (!operationTamper) throw new Error('备份缺少 operation 条目')
    operationTamper.originalPath = join(source.projectRoot, '.git', 'config')
    await writeFile(manifestPath, JSON.stringify(familyTamper))
    const familyResult = await runCli(restoreArgs)
    expect(familyResult.code).toBe(3)
    await expect(readFile(join(source.projectRoot, '.git', 'config'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
    expect(await fileHashes(sourcePaths)).toEqual(before)
  })

  it('拒绝重叠根与画布目录符号链接', async () => {
    const source = await seedMigrationSource()
    const overlap = await runCli([
      'inventory',
      '--state-root',
      source.projectRoot,
      '--project-root',
      source.projectRoot
    ])
    expect(overlap.code).toBe(2)

    const outside = await temporaryRoot('opengalgame-r27-cli-outside-')
    await writeFile(join(outside, 'secret.json'), '{}')
    const link = join(
      source.projectRoot,
      '.opengalgame/canvases',
      Buffer.from('link').toString('hex')
    )
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST') return
      throw error
    }
    const symlinkResult = await runCli([
      'inventory',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ])
    expect(symlinkResult.code).toBe(2)
  })

  it('真实 reader 身份与嵌套 schema：执行文件归属、canvas 路径、operation 文件名', async () => {
    const source = await seedMigrationSource()
    const nestedBad = currentExecution({
      operationId: 'op-nested',
      replies: [{}]
    })
    const extraPolicy = currentExecution({
      operationId: 'op-extra',
      policy: { maxCorrections: 1, passthrough: true }
    })
    const projectMismatch = currentExecution({
      operationId: 'op-project',
      projectId: 'project-other'
    })
    const sceneMismatch = currentExecution({
      operationId: 'op-scene',
      source: {
        projectId: 'project-1',
        sceneId: 'scene-other',
        projectRoot: '/project',
        sceneDirectory: 'game/scene',
        entryFile: 'start.txt'
      }
    })
    await writeExecutions(source.stateRoot, 7, [
      nestedBad,
      extraPolicy,
      projectMismatch,
      sceneMismatch
    ])
    const brokenCanvas = currentCanvasDocument()
    brokenCanvas.canvasId = 'canvas-other'
    await writeFile(source.canvasPath, JSON.stringify(brokenCanvas))
    await writeFile(
      source.operationPath,
      JSON.stringify(operationRecord({ operationId: 'op-other' }))
    )

    const result = await runCli([
      'inventory',
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot
    ])
    expect(result.code).toBe(0)
    const inventory = result.json as {
      families: {
        canvas: Array<Record<string, unknown>>
        execution: Array<{ records: Array<Record<string, unknown>> }>
        operation: Array<Record<string, unknown>>
      }
    }
    const records = Object.fromEntries(
      inventory.families.execution[0]!.records.map((record) => [
        String(record.operationId),
        record
      ])
    ) as Record<string, Record<string, unknown>>
    expect(records['op-nested']).toMatchObject({
      classification: 'legacy',
      resumable: false
    })
    expect(records['op-extra']).toMatchObject({
      classification: 'current',
      resumable: null
    })
    expect(records['op-project']).toMatchObject({ classification: 'unreadable' })
    expect(records['op-scene']).toMatchObject({
      classification: 'current',
      resumable: null
    })
    expect(inventory.families.canvas[0]).toMatchObject({
      classification: 'unreadable',
      identityMatchesPath: false
    })
    expect(inventory.families.operation[0]).toMatchObject({ classification: 'unreadable' })
  })

  it('restore 拒绝目标父链 junction 指向跨 family 目录', async () => {
    const source = await seedMigrationSource()
    const backupParent = await temporaryRoot('opengalgame-r27-cli-junction-')
    const { manifestPath } = await backupSource(source, backupParent, 'batch-junction')
    const sceneDirectory = join(
      source.projectRoot,
      '.opengalgame/canvases',
      Buffer.from('scene-1').toString('hex')
    )
    const operationsDirectory = join(
      source.projectRoot,
      '.git/opengalgame/operations'
    )
    const operationBefore = await readFile(source.operationPath)
    await rm(sceneDirectory, { recursive: true, force: true })
    try {
      await symlink(
        operationsDirectory,
        sceneDirectory,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST') return
      throw error
    }

    const result = await runCli([
      'restore',
      '--manifest',
      manifestPath,
      '--state-root',
      source.stateRoot,
      '--project-root',
      source.projectRoot,
      '--apply'
    ])
    expect(result.code).toBe(3)
    expect(await readFile(source.operationPath)).toEqual(operationBefore)
  })
})
