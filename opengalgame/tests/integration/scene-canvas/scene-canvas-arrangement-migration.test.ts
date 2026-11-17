import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
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
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectServices } from '@bootstrap/projects'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import type { SceneCanvasApplicationService } from '@application/scene-canvas/services/SceneCanvasApplicationService'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import { LocalSceneCanvasArrangementPersistenceGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'
import { SceneInputGatewayImpl } from '@infrastructure/scene-generation/inputs/SceneInputGatewayImpl'

const CLI_PATH = fileURLToPath(
  new URL('../../../scripts/legacy-data-migration/cli.cjs', import.meta.url)
)
const CANVAS_CLI_PATH = fileURLToPath(
  new URL('../../../scripts/legacy-data-migration/canvas-migrate.cjs', import.meta.url)
)
const execFileAsync = promisify(execFile)
const r27Manifest = createRequire(import.meta.url)(
  '../../../scripts/legacy-data-migration/manifest.cjs'
) as { assertManifest(value: unknown): unknown }
const directories: string[] = []
const closers: Array<() => Promise<void>> = []

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

const dialogs = {
  selectDirectory: async () => null,
  chooseSaveLocation: async () => null,
  takeSaveLocation: async () => null,
  clearSaveLocation: () => undefined
}

type BackupManifest = {
  batchId: string
  backupRoot: string
  scope: { projectRoots: string[] }
  entries: {
    originalPath: string
    backupPath: string
    sha256: string
    sizeBytes: number
  }[]
}

type CanvasFixture = {
  formatVersion: number
  projectId: string
  sceneId: string
  canvasId: string
  viewport: { x: number; y: number; zoom: number }
  cards: Record<string, unknown>[]
  relations: Record<string, unknown>[]
}

type ProjectServicesFixture = {
  sceneCanvas: SceneCanvasApplicationService
  close: () => Promise<void>
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function layout(x: number): { x: number; y: number; width: number; height: number } {
  return { x, y: 0, width: 100, height: 80 }
}

function v3Canvas(canvasId: string, projectId = 'project-1'): CanvasFixture {
  return {
    formatVersion: 3,
    projectId,
    sceneId: 'scene-1',
    canvasId,
    viewport: { x: 1, y: 2, zoom: 1.5 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '设定',
        summary: '设定摘要',
        usage: { characterId: 'char-1', targetIds: [] },
        layout: layout(0)
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        title: '提示词',
        summary: '提示词摘要',
        body: '提示词正文',
        usage: { locationId: 'room-1', targetIds: ['doc'] },
        layout: layout(20)
      }
    ],
    relations: [
      {
        relationId: 'rel',
        fromCardId: 'prompt',
        toCardId: 'doc',
        defaultRelation: 'actsOn',
        specificName: '引用',
        recordCardId: 'doc'
      }
    ]
  }
}

function v4Canvas(canvasId: string): CanvasFixture {
  return {
    formatVersion: 4,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '设定',
        summary: '设定摘要',
        layout: layout(0)
      },
      {
        kind: 'video',
        cardId: 'video',
        sourceId: 'source-video',
        title: '开场',
        layout: layout(20)
      }
    ],
    relations: [
      {
        relationId: 'rel',
        fromCardId: 'video',
        toCardId: 'doc',
        specificName: '引用',
        recordCardId: null
      }
    ]
  }
}

function currentCanvas(canvasId: string): CanvasFixture {
  return {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '当前设定',
        summary: '当前摘要',
        usage: { characterId: 'char-1', targetIds: [] },
        layout: layout(0)
      }
    ],
    relations: []
  }
}

function promptOnlyCanvas(formatVersion: 3 | 4 | 5, canvasId: string): CanvasFixture {
  const prompt =
    formatVersion === 3
      ? {
          kind: 'prompt',
          cardId: 'prompt',
          title: '生成提示词',
          summary: '生成摘要',
          body: '写一段剧情',
          usage: { targetIds: [] },
          layout: layout(0)
        }
      : formatVersion === 5
        ? {
            kind: 'prompt',
            cardId: 'prompt',
            title: '当前提示词',
            summary: '',
            body: '当前正文',
            references: [],
            usage: { targetIds: [] },
            layout: layout(0)
          }
        : {
            kind: 'prompt',
            cardId: 'prompt',
            body: '写一段剧情',
            layout: layout(0)
          }
  return {
    formatVersion,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [prompt],
    relations: []
  }
}

async function seedProject(projectRoot: string, projectId = 'project-1'): Promise<void> {
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await mkdir(join(projectRoot, 'assets'), { recursive: true })
  await mkdir(join(projectRoot, 'game', 'scene'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame', 'manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId, operationId: `op-${projectId}` })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'project.json'),
    JSON.stringify({ id: projectId, name: '作品', synopsis: '' })
  )
  await writeFile(join(projectRoot, 'game', 'scene', 'start.txt'), '')
}

async function fixture(
  projectIds: readonly string[] = ['project-1']
): Promise<{ root: string; userDirectory: string; projects: { id: string; directory: string }[] }> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-canvas-migration-'))
  directories.push(root)
  const userDirectory = join(root, 'app')
  const projects: { id: string; directory: string }[] = []
  for (const [index, id] of projectIds.entries()) {
    const directory = join(root, index === 0 ? 'project' : id)
    await seedProject(directory, id)
    projects.push({ id, directory })
  }
  await writeProjectRegistrations(
    userDirectory,
    projects.map((project, index) => ({
      id: project.id,
      directory: project.directory,
      operationId: `op-${index + 1}`
    }))
  )
  return { root, userDirectory, projects }
}

function servicesFor(userDirectory: string): ProjectServicesFixture {
  const services = createProjectServices({ userDirectory, dialogs, logger })
  closers.push(services.close)
  return services
}

async function writeCanvas(
  projectRoot: string,
  sceneId: string,
  canvasId: string,
  document: unknown
): Promise<string> {
  const target = join(projectRoot, arrangementPath(sceneId, canvasId))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(document))
  return target
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileDigest(path: string): Promise<string> {
  return sha256(await readFile(path))
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(left) === normalize(right)
}

async function backupBatches(backupRoot: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(backupRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => join(backupRoot, name))
}

async function manifestAt(batchDirectory: string): Promise<BackupManifest> {
  const value = JSON.parse(await readFile(join(batchDirectory, 'manifest.json'), 'utf8'))
  r27Manifest.assertManifest(value)
  return value as BackupManifest
}

async function findBatch(
  backupRoot: string,
  target: string
): Promise<{ directory: string; manifest: BackupManifest } | null> {
  for (const directory of await backupBatches(backupRoot)) {
    const manifest = await manifestAt(directory)
    if (manifest.entries.some((entry) => samePath(entry.originalPath, target))) {
      return { directory, manifest }
    }
  }
  return null
}

async function runCli(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, [script, ...args], {
    cwd: resolve(dirname(script), '..', '..'),
    encoding: 'utf8'
  })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

async function runCliExpectFailure(
  script: string,
  args: string[]
): Promise<{ code: number | string; stdout: string; stderr: string }> {
  let result: { stdout: string | Buffer; stderr: string | Buffer } | null = null
  try {
    result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: resolve(dirname(script), '..', '..'),
      encoding: 'utf8'
    })
  } catch (error) {
    const failure = error as {
      code?: number | string
      stdout?: string
      stderr?: string
    }
    return {
      code: failure.code ?? '',
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? '')
    }
  }
  throw new Error(`预期 CLI 失败但成功：${String(result.stdout)}`)
}

async function tryJunction(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false
    throw error
  }
}

describe('画布旧格式真实读写迁移', () => {
  it('真实工程首次读取迁移 v3/v4，备份可被 R27 verify/restore 消费且再次读取复用批次', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const v3Target = await writeCanvas(projectRoot, 'scene-1', 'canvas-v3', v3Canvas('canvas-v3'))
    const v4Target = await writeCanvas(projectRoot, 'scene-1', 'canvas-v4', v4Canvas('canvas-v4'))
    const v3Original = await readFile(v3Target)
    const v4Original = await readFile(v4Target)
    const services = servicesFor(world.userDirectory)

    const readV3 = await services.sceneCanvas.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-v3'
    })
    expect(readV3?.cards).toHaveLength(2)
    expect(readV3?.cards[0]).toMatchObject({
      kind: 'document',
      title: '设定',
      summary: '设定摘要',
      layout: layout(0)
    })
    expect(readV3?.cards[1]).toMatchObject({
      kind: 'prompt',
      body: '提示词正文',
      references: [],
      layout: layout(20)
    })

    const readV4 = await services.sceneCanvas.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-v4'
    })
    expect(readV4?.cards[1]).toMatchObject({
      kind: 'video',
      title: '开场',
      summary: '',
      layout: layout(20)
    })

    const migratedV3 = JSON.parse(await readFile(v3Target, 'utf8')) as {
      formatVersion: number
      cards: Record<string, unknown>[]
      relations: Record<string, unknown>[]
    }
    expect(migratedV3.formatVersion).toBe(SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION)
    expect(migratedV3.cards[1]).toMatchObject({
      title: '提示词',
      summary: '提示词摘要',
      body: '提示词正文',
      usage: { locationId: 'room-1', targetIds: ['doc'] }
    })
    expect(migratedV3.relations[0]).toMatchObject({ defaultRelation: 'actsOn' })

    const backupRoot = join(world.userDirectory, 'migrations', 'scene-canvas')
    expect(await backupBatches(backupRoot)).toHaveLength(2)
    const projectRootReal = await realpath(projectRoot)
    for (const directory of await backupBatches(backupRoot)) {
      expect((await manifestAt(directory)).scope.projectRoots).toEqual([projectRootReal])
    }
    const v3Batch = await findBatch(backupRoot, v3Target)
    const v4Batch = await findBatch(backupRoot, v4Target)
    if (v3Batch === null || v4Batch === null) throw new Error('缺少迁移备份批次')
    expect(
      await readFile(join(v3Batch.directory, ...v3Batch.manifest.entries[0]!.backupPath.split('/')))
    ).toEqual(v3Original)
    expect(
      await readFile(join(v4Batch.directory, ...v4Batch.manifest.entries[0]!.backupPath.split('/')))
    ).toEqual(v4Original)

    const verified = await runCli(CLI_PATH, [
      'verify',
      '--manifest',
      join(v3Batch.directory, 'manifest.json')
    ])
    const verifyOutput = JSON.parse(verified.stdout) as {
      command: string
      ok: boolean
      readable: boolean
      dryRun: boolean
      summary: { legacy: number }
    }
    expect(verifyOutput).toMatchObject({
      command: 'verify',
      ok: true,
      readable: true,
      dryRun: true
    })
    expect(verifyOutput.summary.legacy).toBe(1)

    const restored = await runCli(CLI_PATH, [
      'restore',
      '--manifest',
      join(v3Batch.directory, 'manifest.json'),
      '--project-root',
      projectRootReal,
      '--apply'
    ])
    expect(JSON.parse(restored.stdout)).toMatchObject({
      command: 'restore',
      ok: true,
      dryRun: false
    })
    expect(await readFile(v3Target)).toEqual(v3Original)

    const beforeReopen = (await backupBatches(backupRoot)).length
    const reopened = await services.sceneCanvas.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-v3'
    })
    expect(reopened?.cards).toHaveLength(2)
    expect((await backupBatches(backupRoot)).length).toBe(beforeReopen)
    expect(JSON.parse(await readFile(v3Target, 'utf8'))).toMatchObject({
      formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION
    })
    expect((await readdir(backupRoot)).filter((name) => name.startsWith('.staging-'))).toEqual([])
  }, 30_000)

  it('当前 v5 读取不写文件也不生成备份', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-current',
      currentCanvas('canvas-current')
    )
    const before = await fileDigest(target)
    const services = servicesFor(world.userDirectory)
    const read = await services.sceneCanvas.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-current'
    })
    expect(read?.cards[0]).toMatchObject({ title: '当前设定', summary: '当前摘要' })
    expect(await fileDigest(target)).toBe(before)
    expect(await backupBatches(join(world.userDirectory, 'migrations', 'scene-canvas'))).toEqual([])
  })

  it('未访问工程字节与备份不变，首次打开后迁移', async () => {
    const world = await fixture(['project-1', 'project-2'])
    const first = world.projects[0]!
    const second = world.projects[1]!
    await writeCanvas(first.directory, 'scene-1', 'canvas-open', v3Canvas('canvas-open'))
    const untouched = await writeCanvas(
      second.directory,
      'scene-1',
      'canvas-later',
      v3Canvas('canvas-later', 'project-2')
    )
    const untouchedDigest = await fileDigest(untouched)
    const services = servicesFor(world.userDirectory)

    await services.sceneCanvas.readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-open'
    })
    expect(await fileDigest(untouched)).toBe(untouchedDigest)
    const backupRoot = join(world.userDirectory, 'migrations', 'scene-canvas')
    expect(await findBatch(backupRoot, untouched)).toBeNull()

    await services.sceneCanvas.readSceneCanvasArrangement({
      projectId: 'project-2',
      sceneId: 'scene-1',
      canvasId: 'canvas-later'
    })
    expect(await fileDigest(untouched)).not.toBe(untouchedDigest)
    expect(await findBatch(backupRoot, untouched)).not.toBeNull()
  })

  it('生成输入读取前迁移 v3/v4，当前 v5 输入不受影响', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const backupRoot = join(world.userDirectory, 'migrations', 'scene-canvas')
    const migration = new CanvasArrangementMigration({ backupRoot })
    const source = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    }
    const gateway = new SceneInputGatewayImpl([{ source }], migration)

    const v3Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-gen3',
      promptOnlyCanvas(3, 'canvas-gen3')
    )
    const v3Original = await readFile(v3Target)
    const v3Inputs = await gateway.readInputs(source, {
      canvasId: 'canvas-gen3',
      confirmedControls: []
    })
    expect(v3Inputs.prompts[0]).toMatchObject({
      title: '生成提示词',
      body: '写一段剧情',
      references: [],
      usage: { targetIds: [] }
    })
    expect(JSON.parse(await readFile(v3Target, 'utf8'))).toMatchObject({ formatVersion: 5 })

    const v4Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-gen4',
      promptOnlyCanvas(4, 'canvas-gen4')
    )
    const v4Original = await readFile(v4Target)
    const v4Inputs = await gateway.readInputs(source, {
      canvasId: 'canvas-gen4',
      confirmedControls: []
    })
    expect(v4Inputs.prompts[0]).toMatchObject({
      title: 'prompt',
      body: '写一段剧情',
      references: [],
      usage: { targetIds: [] }
    })
    expect(JSON.parse(await readFile(v4Target, 'utf8'))).toMatchObject({ formatVersion: 5 })

    const projectRootReal = await realpath(projectRoot)
    for (const restored of [
      { target: v3Target, original: v3Original, inputs: v3Inputs, canvasId: 'canvas-gen3' },
      { target: v4Target, original: v4Original, inputs: v4Inputs, canvasId: 'canvas-gen4' }
    ]) {
      const batch = await findBatch(backupRoot, restored.target)
      if (batch === null) throw new Error('生成输入首次读取缺少备份批次')
      await runCli(CLI_PATH, [
        'restore',
        '--manifest',
        join(batch.directory, 'manifest.json'),
        '--project-root',
        projectRootReal,
        '--apply'
      ])
      expect(await readFile(restored.target)).toEqual(restored.original)
      const reread = await gateway.readInputs(source, {
        canvasId: restored.canvasId,
        confirmedControls: []
      })
      expect(reread).toEqual(restored.inputs)
    }

    const currentTarget = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-gen5',
      promptOnlyCanvas(5, 'canvas-gen5')
    )
    const currentDigest = await fileDigest(currentTarget)
    await gateway.readInputs(source, { canvasId: 'canvas-gen5', confirmedControls: [] })
    expect(await fileDigest(currentTarget)).toBe(currentDigest)
    expect(await findBatch(backupRoot, currentTarget)).toBeNull()
  }, 30_000)

  it('CLI 默认 dry-run，apply 后可由 R27 verify/restore 还原', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const projectRootReal = await realpath(projectRoot)
    const v3Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-cli3',
      v3Canvas('canvas-cli3')
    )
    const v4Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-cli4',
      v4Canvas('canvas-cli4')
    )
    const v3Original = await readFile(v3Target)
    const v4OriginalDigest = await fileDigest(v4Target)
    const backupRoot = join(world.root, 'cli-backup')

    const dryRun = await runCli(CANVAS_CLI_PATH, [
      '--project-root',
      projectRoot,
      '--backup-root',
      backupRoot
    ])
    const dryRunOutput = JSON.parse(dryRun.stdout) as {
      dryRun: boolean
      summary: { total: number; wouldMigrate: number; migrated: number }
      files: { status: string }[]
    }
    expect(dryRunOutput.dryRun).toBe(true)
    expect(dryRunOutput.summary).toMatchObject({ total: 2, wouldMigrate: 2, migrated: 0 })
    expect(await fileDigest(v3Target)).toBe(sha256(v3Original))
    expect(await fileDigest(v4Target)).toBe(v4OriginalDigest)
    expect(await backupBatches(backupRoot)).toEqual([])

    const applied = await runCli(CANVAS_CLI_PATH, [
      '--project-root',
      projectRoot,
      '--backup-root',
      backupRoot,
      '--apply'
    ])
    const appliedOutput = JSON.parse(applied.stdout) as {
      dryRun: boolean
      summary: { migrated: number; failed: number }
    }
    expect(appliedOutput).toMatchObject({ dryRun: false })
    expect(appliedOutput.summary).toMatchObject({ migrated: 2, failed: 0 })
    expect(JSON.parse(await readFile(v3Target, 'utf8'))).toMatchObject({ formatVersion: 5 })

    const batch = await findBatch(backupRoot, v3Target)
    if (batch === null) throw new Error('CLI 未生成 v3 备份批次')
    const verified = await runCli(CLI_PATH, [
      'verify',
      '--manifest',
      join(batch.directory, 'manifest.json')
    ])
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, readable: true })
    await runCli(CLI_PATH, [
      'restore',
      '--manifest',
      join(batch.directory, 'manifest.json'),
      '--project-root',
      projectRootReal,
      '--apply'
    ])
    expect(await readFile(v3Target)).toEqual(v3Original)
  }, 60_000)

  it('备份根位于工程内时不写来源，v4/v3 都按格式不支持拒绝', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const v4Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-neg4',
      v4Canvas('canvas-neg4')
    )
    const v3Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-neg3',
      v3Canvas('canvas-neg3')
    )
    const v4Digest = await fileDigest(v4Target)
    const v3Digest = await fileDigest(v3Target)
    const store = new LocalSceneCanvasArrangementPersistenceGatewayImpl(
      async (projectId) => ({ projectId, directory: projectRoot }),
      new CanvasArrangementMigration({ backupRoot: join(projectRoot, 'backups') })
    )
    await expect(
      store.readArrangement('project-1', 'scene-1', 'canvas-neg4')
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.unsupportedFormat })
    expect(await fileDigest(v4Target)).toBe(v4Digest)
    await expect(
      store.readArrangement('project-1', 'scene-1', 'canvas-neg3')
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.unsupportedFormat })
    expect(await fileDigest(v3Target)).toBe(v3Digest)
    await expect(lstat(join(projectRoot, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('画布目录经链接越出工程时拒绝迁移且链接目标不变', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const outside = join(world.root, 'outside-canvases')
    const sceneKey = '7363656e652d31'
    const canvasKey = '63616e7661732d6c696e6b'
    const outsideScene = join(outside, sceneKey)
    await mkdir(outsideScene, { recursive: true })
    const outsideTarget = join(outsideScene, `${canvasKey}.json`)
    await writeFile(outsideTarget, JSON.stringify(v4Canvas('canvas-link')))
    const outsideDigest = await fileDigest(outsideTarget)
    try {
      await symlink(
        outside,
        join(projectRoot, '.opengalgame', 'canvases'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return
      throw error
    }
    const migration = new CanvasArrangementMigration({
      backupRoot: join(world.root, 'link-backup')
    })
    const outcome = await migration.ensureCurrent({
      projectId: 'project-1',
      directory: projectRoot,
      sceneId: 'scene-link',
      canvasId: 'canvas-link',
      trigger: 'open'
    })
    expect(outcome).toMatchObject({ status: 'failed', failure: { stage: 'resolve' } })
    expect(await fileDigest(outsideTarget)).toBe(outsideDigest)
    expect(await backupBatches(join(world.root, 'link-backup'))).toEqual([])
  })

  it('备份根经 junction 指向工程内（含缺失尾段）时拒绝写入且工程零写', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const v4Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-junction4',
      v4Canvas('canvas-junction4')
    )
    const v3Target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-junction3',
      v3Canvas('canvas-junction3')
    )
    const v4Digest = await fileDigest(v4Target)
    const v3Digest = await fileDigest(v3Target)
    const inside = join(projectRoot, '.backup-inside')
    await mkdir(inside)
    const link = join(world.root, 'backup-link')
    if (!(await tryJunction(inside, link))) return
    const store = new LocalSceneCanvasArrangementPersistenceGatewayImpl(
      async (projectId) => ({ projectId, directory: projectRoot }),
      new CanvasArrangementMigration({
        backupRoot: join(link, 'migrations', 'scene-canvas')
      })
    )
    await expect(
      store.readArrangement('project-1', 'scene-1', 'canvas-junction4')
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.unsupportedFormat })
    expect(await fileDigest(v4Target)).toBe(v4Digest)
    expect(await readdir(inside)).toEqual([])
    await expect(
      store.readArrangement('project-1', 'scene-1', 'canvas-junction3')
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.unsupportedFormat })
    expect(await fileDigest(v3Target)).toBe(v3Digest)
    expect(await readdir(inside)).toEqual([])
  })

  it('备份根经 junction 指向工程外合法目录时正常迁移', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-external',
      v4Canvas('canvas-external')
    )
    const external = join(world.root, 'external-backup')
    await mkdir(external)
    const link = join(world.root, 'external-backup-link')
    if (!(await tryJunction(external, link))) return
    const store = new LocalSceneCanvasArrangementPersistenceGatewayImpl(
      async (projectId) => ({ projectId, directory: projectRoot }),
      new CanvasArrangementMigration({
        backupRoot: join(link, 'migrations', 'scene-canvas')
      })
    )
    const read = await store.readArrangement('project-1', 'scene-1', 'canvas-external')
    expect(read?.arrangement.cards[1]).toMatchObject({ kind: 'video', summary: '' })
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ formatVersion: 5 })
    const batches = await backupBatches(join(external, 'migrations', 'scene-canvas'))
    expect(batches).toHaveLength(1)
    expect((await manifestAt(batches[0]!)).entries).toHaveLength(1)
  })

  it('CLI 备份根经 junction 指向工程内时拒绝且零写', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-cli-link',
      v4Canvas('canvas-cli-link')
    )
    const digest = await fileDigest(target)
    const inside = join(projectRoot, '.cli-backup-inside')
    await mkdir(inside)
    const link = join(world.root, 'cli-backup-link')
    if (!(await tryJunction(inside, link))) return
    const failure = await runCliExpectFailure(CANVAS_CLI_PATH, [
      '--project-root',
      projectRoot,
      '--backup-root',
      join(link, 'migrations', 'scene-canvas'),
      '--apply'
    ])
    expect(failure.code).toBe(2)
    const payload = JSON.parse(failure.stdout) as { ok: boolean; error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('备份根真实路径')
    expect(await fileDigest(target)).toBe(digest)
    expect(await readdir(inside)).toEqual([])
  }, 30_000)

  it('原子替换失败时保持源文件与备份且不留临时文件', async () => {
    if (process.platform !== 'win32') return
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-atomic',
      v4Canvas('canvas-atomic')
    )
    const digest = await fileDigest(target)
    const backupRoot = join(world.root, 'atomic-backup')
    const migration = new CanvasArrangementMigration({ backupRoot })
    await chmod(target, 0o444)
    try {
      const outcome = await migration.ensureCurrent({
        projectId: 'project-1',
        directory: projectRoot,
        sceneId: 'scene-1',
        canvasId: 'canvas-atomic',
        trigger: 'open'
      })
      expect(outcome).toMatchObject({ status: 'failed', failure: { stage: 'write' } })
      expect(await fileDigest(target)).toBe(digest)
      expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ formatVersion: 4 })
      expect(await backupBatches(backupRoot)).toHaveLength(1)
      expect(
        (await readdir(dirname(target))).filter((name) => name.startsWith('.opengalgame-tmp-'))
      ).toEqual([])
    } finally {
      await chmod(target, 0o666)
    }
  })

  it('CLI 报告写入失败时不返回不存在的 reportPath', async () => {
    const world = await fixture()
    const projectRoot = world.projects[0]!.directory
    const target = await writeCanvas(
      projectRoot,
      'scene-1',
      'canvas-report',
      v3Canvas('canvas-report')
    )
    const original = await readFile(target)
    const backupRoot = join(world.root, 'report-backup')
    await runCli(CANVAS_CLI_PATH, [
      '--project-root',
      projectRoot,
      '--backup-root',
      backupRoot,
      '--apply'
    ])
    const batch = await findBatch(backupRoot, target)
    if (batch === null) throw new Error('未生成报告失败测试所需批次')
    await writeFile(target, original)
    const reportPath = join(batch.directory, 'report.json')
    await rm(reportPath, { force: true })
    await mkdir(reportPath)
    try {
      const result = await runCli(CANVAS_CLI_PATH, [
        '--project-root',
        projectRoot,
        '--backup-root',
        backupRoot,
        '--apply'
      ])
      const output = JSON.parse(result.stdout) as {
        files: { relativePath: string; status: string; reportPath?: string | null }[]
      }
      expect(output.files).toHaveLength(1)
      const file = output.files[0]
      expect(file?.status).toBe('migrated')
      expect(file?.reportPath ?? null).toBeNull()
      expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ formatVersion: 5 })
    } finally {
      await rm(reportPath, { recursive: true, force: true })
    }
  }, 60_000)
})
