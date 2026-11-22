import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type {
  SceneGenerationBaseline,
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import { ExportSavedScene } from '@application/scene-export/services/impl/ExportSavedScene'
import { ReadLatestSavedSceneVersionUseCase } from '@application/scene-export/services/ReadLatestSavedSceneVersionUseCase'
import type { SavedSceneExportSource } from '@application/scene-export/ports/SceneExportSourceGateway'
import type {
  WindowsScenePackageResult,
  WindowsScenePackager
} from '@application/scene-export/ports/WindowsScenePackager'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalSavedSceneVersionQueryGateway } from '@infrastructure/scene-export/LocalSavedSceneVersionQueryGateway'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import { SceneVersionGatewayImpl } from '@infrastructure/scene-generation/versions/SceneVersionGatewayImpl'
import { LocalScenePreviewSourceGateway } from '@infrastructure/scene-preview/LocalScenePreviewSourceGateway'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'

const roots: string[] = []
const entryRelativePath = 'game/scene/start.txt'
const script = '小明:提交前的一句 -next;\r\nchangeBg:room.webp;\r\nchangeFigure:hero.png;\r\n'
const committedScript =
  '小明:已接受的生成候选 -next;\r\nchangeBg:room.webp;\r\nchangeFigure:hero.png;\r\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface World {
  userDirectory: string
  projectRoot: string
  source: SceneSourceLocation
  otherSource: SceneSourceLocation
}

async function registeredWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'generation-export-'))
  roots.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  for (const sceneId of ['scene-1', 'scene-2']) {
    await mkdir(join(projectRoot, '.opengalgame/canvases', encodeStorageKey(sceneId)), {
      recursive: true
    })
    await writeFile(
      join(projectRoot, '.opengalgame/canvases', encodeStorageKey(sceneId), 'canvas.json'),
      '{}'
    )
  }
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, 'game/figure'), { recursive: true })
  await mkdir(join(projectRoot, 'game/background'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame/project.json'),
    JSON.stringify({ id: 'project-1', name: '生成导出工程', synopsis: '' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-register' })
  )
  await writeFile(join(projectRoot, entryRelativePath), script, 'utf8')
  await writeFile(join(projectRoot, 'game/figure/hero.png'), Uint8Array.of(1, 2, 3))
  await writeFile(join(projectRoot, 'game/background/room.webp'), Uint8Array.of(9, 8, 7))
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    JSON.stringify({
      scenes: [
        { sceneId: 'scene-1', lockState: 'unlocked' },
        { sceneId: 'scene-2', lockState: 'unlocked' }
      ]
    })
  )
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  execFileSync('git', ['init'], { cwd: projectRoot })
  await createProjectVersioningGateways(userDirectory).transactions.initializeBaseline({
    projectId: 'project-1',
    initialPaths: [
      entryRelativePath,
      'game/figure/hero.png',
      'game/background/room.webp',
      '.opengalgame/scene-locks.json',
      '.opengalgame/project.json'
    ]
  })
  return {
    userDirectory,
    projectRoot,
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    otherSource: {
      projectId: 'project-1',
      sceneId: 'scene-2',
      projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    }
  }
}

function versioning(userDirectory: string): ManageProjectVersioning {
  return new ManageProjectVersioning({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => `op-generation-export-${Math.random().toString(16).slice(2)}`
  })
}

function previewSources(userDirectory: string): LocalScenePreviewSourceGateway {
  return new LocalScenePreviewSourceGateway(
    new RegisteredSceneLocationGatewayImpl(userDirectory),
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
}

async function commitGeneration(
  world: World,
  options: {
    source?: SceneSourceLocation
    content?: string
    operationId?: string
    candidateSnapshotId?: string
    skipCandidate?: boolean
  } = {}
): Promise<{
  operationId: string
  commitId: string
  contentBasis: { digest: string; parserVersion: string; engineVersion: string }
}> {
  const source = options.source ?? world.source
  const content = options.content ?? committedScript
  const operationId = options.operationId ?? 'caller-generation-1'
  const versioningService = versioning(world.userDirectory)
  const gateway = new SceneVersionGatewayImpl(versioningService, {
    ensureProjectWorkspace: async () => {
      throw new Error('测试不启动工作区核对')
    }
  })
  const baseline = await gateway.readBaseline(source)
  let candidateSnapshotId = options.candidateSnapshotId ?? 'candidate-1'
  if (!options.skipCandidate) {
    const files = new AiProjectFileSystemImpl(world.userDirectory)
    const workspace = await files.createWorkspace({
      projectId: source.projectId,
      threadId: 'thread-1',
      operationId,
      projectRoot: world.projectRoot,
      sourcePaths: [`${source.sceneDirectory}/${source.entryFile}`]
    })
    await files.writeFile(
      workspace,
      `${source.sceneDirectory}/${source.entryFile}`,
      new TextEncoder().encode(content)
    )
    const revision = await files.saveRevision(workspace)
    await files.discardWorkspace(workspace)
    candidateSnapshotId = revision.revisionId
  }
  const committed = await gateway.commitCandidate(
    execution(world, source, baseline, operationId),
    candidate(source, candidateSnapshotId),
    () => undefined
  )
  const preview = await previewSources(world.userDirectory).readScenePreviewSource(source)
  return { operationId, commitId: committed.commitId, contentBasis: preview.contentBasis }
}

function queryService(
  world: World,
  versioningService: ProjectVersioningApplicationService = versioning(world.userDirectory)
): ReadLatestSavedSceneVersionUseCase {
  return new ReadLatestSavedSceneVersionUseCase(
    new LocalSavedSceneVersionQueryGateway(
      world.userDirectory,
      versioningService,
      previewSources(world.userDirectory)
    )
  )
}

function sourceGateway(
  world: World,
  versioningService: ProjectVersioningApplicationService = versioning(world.userDirectory)
): LocalSceneExportSourceGateway {
  return new LocalSceneExportSourceGateway(
    world.userDirectory,
    versioningService,
    previewSources(world.userDirectory)
  )
}

function exportService(
  gateway: LocalSceneExportSourceGateway,
  packager: WindowsScenePackager
): ExportSavedScene {
  return new ExportSavedScene({
    sources: gateway,
    destinations: {
      chooseParentDirectory: async () => ({ status: 'canceled' }),
      resolveDestination: async () => ({
        kind: 'workspace',
        parentDirectory: 'D:/opengalgame/projects/generated/exports',
        projectRoot: 'D:/opengalgame/projects/generated'
      })
    },
    packager
  })
}

function execution(
  world: World,
  source: SceneSourceLocation,
  baseline: SceneGenerationBaseline,
  operationId: string
): SceneGenerationExecution {
  return {
    projectId: world.source.projectId,
    sceneId: source.sceneId,
    operationId,
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint-1',
    source,
    inputSnapshot: {
      canvasId: 'canvas-1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 2 },
    reviewCandidate: false,
    baseline,
    state: 'committing',
    step: 'committing',
    attempt: 0,
    sequence: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  }
}

function candidate(source: SceneSourceLocation, candidateSnapshotId: string): SceneGenerationCandidate {
  return {
    candidateSnapshotId,
    artifact: {
      scene: { projectId: source.projectId, sceneId: source.sceneId },
      hasEntry: true,
      statements: []
    },
    preview: {
      entryFile: `${source.sceneDirectory}/${source.entryFile}`,
      files: [`${source.sceneDirectory}/${source.entryFile}`],
      parserVersion: '4.6.5',
      commandLocations: [],
      validationReport: { ok: true, issues: [] }
    },
    assetChanges: []
  } as unknown as SceneGenerationCandidate
}

function capturingPackager(): { packager: WindowsScenePackager; source: () => SavedSceneExportSource | null } {
  let captured: SavedSceneExportSource | null = null
  return {
    source: () => captured,
    packager: {
      async packageWindowsScene(input): Promise<WindowsScenePackageResult> {
        captured = input
        return {
          status: 'succeeded',
          artifact: {
            executableName: 'WebGAL.exe',
            directoryName: 'generation-scene',
            directoryPath: 'D:/opengalgame/exports/generation-scene',
            bytes: 128,
            containsFixedEngine: true,
            entryRelativePath: input.entryRelativePath,
            contentBasis: input.contentBasis,
            versionReference: input.versionReference
          }
        }
      },
      async verifyWindowsScene() {
        return true
      }
    }
  }
}

describe('生成提交作为单场景导出来源', () => {
  it('真实候选提交且没有预览保存时，统一查询返回生成提交并允许导出', async () => {
    const world = await registeredWorld()
    const committed = await commitGeneration(world)
    await expect(
      stat(join(world.projectRoot, '.git/opengalgame/scene-preview-saves'))
    ).rejects.toThrow()

    const latest = await queryService(world).readLatestSavedSceneVersion({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    expect(latest).toEqual({
      versionReference: {
        kind: 'generation-commit',
        operationId: committed.operationId,
        commitId: committed.commitId
      },
      revisionDigest: createHash('sha256').update(committedScript).digest('hex'),
      contentBasis: committed.contentBasis
    })
    if (!latest) throw new Error('没有查询到生成提交版本')

    const captured = capturingPackager()
    const result = await exportService(sourceGateway(world), captured.packager).exportSavedScene({
      projectId: 'project-1',
      sceneId: 'scene-1',
      contentBasis: latest.contentBasis,
      versionReference: latest.versionReference
    })
    expect(result.status).toBe('succeeded')
    expect(captured.source()?.sceneText).toBe(committedScript)
    expect(captured.source()?.versionReference).toEqual(latest.versionReference)
    expect(captured.source()?.referencedAssets.map((asset) => asset.packagePath)).toEqual([
      'game/background/room.webp',
      'game/figure/hero.png'
    ])
    if (result.status !== 'succeeded') throw new Error('导出没有成功')
    expect(result.artifact.versionReference).toEqual(latest.versionReference)
    expect(result.artifact.entryRelativePath).toBe(entryRelativePath)
  })

  it('伪造 commit、未提交操作和跨场景 operation 都不能通过导出授权', async () => {
    const world = await registeredWorld()
    const otherCommitted = await commitGeneration(world, {
      source: world.otherSource,
      operationId: 'caller-generation-other',
      content: '小明:另一场景的生成结果;\r\n'
    })
    const committed = await commitGeneration(world)
    const latest = await queryService(world).readLatestSavedSceneVersion({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    if (!latest) throw new Error('没有查询到生成提交版本')
    expect(latest.versionReference).toEqual({
      kind: 'generation-commit',
      operationId: committed.operationId,
      commitId: committed.commitId
    })
    const gateway = sourceGateway(world)

    const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD~1'], {
      cwd: world.projectRoot,
      encoding: 'utf8'
    }).trim()
    await expect(
      gateway.readSavedScene({
        projectId: 'project-1',
        sceneId: 'scene-1',
        contentBasis: latest.contentBasis,
        versionReference: {
          kind: 'generation-commit',
          operationId: committed.operationId,
          commitId: baselineCommit
        }
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.saveNotCommitted })

    await expect(
      gateway.readSavedScene({
        projectId: 'project-1',
        sceneId: 'scene-1',
        contentBasis: latest.contentBasis,
        versionReference: {
          kind: 'generation-commit',
          operationId: 'never-committed-operation',
          commitId: committed.commitId
        }
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.saveNotCommitted })

    await expect(
      gateway.readSavedScene({
        projectId: 'project-1',
        sceneId: 'scene-1',
        contentBasis: latest.contentBasis,
        versionReference: {
          kind: 'generation-commit',
          operationId: otherCommitted.operationId,
          commitId: otherCommitted.commitId
        }
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.saveNotCommitted })
  })

  it('正式内容被手工改变后，旧生成提交在查询和打包前都被拒绝', async () => {
    const world = await registeredWorld()
    await commitGeneration(world)
    const latest = await queryService(world).readLatestSavedSceneVersion({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    if (!latest) throw new Error('没有查询到生成提交版本')
    await writeFile(join(world.projectRoot, entryRelativePath), '小明:手工改写;\r\n', 'utf8')

    await expect(
      queryService(world).readLatestSavedSceneVersion({ projectId: 'project-1', sceneId: 'scene-1' })
    ).resolves.toBeNull()
    const captured = capturingPackager()
    await expect(
      exportService(sourceGateway(world), captured.packager).exportSavedScene({
        projectId: 'project-1',
        sceneId: 'scene-1',
        contentBasis: latest.contentBasis,
        versionReference: latest.versionReference
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.savedContentMismatch })
    expect(captured.source()).toBeNull()
  })
})
