import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { openPath: async () => '' }
}))

import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as git from 'isomorphic-git'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { ProjectFileDialogGateway } from '@application/projects/ports/ProjectFileDialogGateway'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { createProjectServices } from '@bootstrap/projects'
import { arrangementPath, documentBodyPath } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { SceneVersionGatewayImpl } from '@infrastructure/scene-generation/versions/SceneVersionGatewayImpl'

const directories: string[] = []
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('版本后端装配', () => {
  it('同一登记工程的文件与画布进入同一版本历史，另一登记根看不到', async () => {
    const world = await registeredProject()
    const services = createProjectServices({
      userDirectory: world.userDirectory,
      dialogs: dialogs(),
      logger
    })
    const stranger = createProjectServices({
      userDirectory: join(world.root, 'other-app'),
      dialogs: dialogs(),
      logger
    })

    const catalog = await services.projectFiles.listProjectInputSources({
      projectId: 'project-1'
    })
    const imported = await services.projectFiles.importProjectFiles({
      projectId: 'project-1',
      expectedCatalogVersion: catalog.catalogVersion,
      localFilePaths: [world.sourceFile],
      parentFolderId: null
    })
    const saved: void = await services.sceneCanvas.saveSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'manual',
      arrangement: emptyArrangement('project-1')
    })
    expect(saved).toBeUndefined()

    const history = await services.versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    expect(history.entries.map((entry) => entry.sourceModule).sort()).toEqual([
      'project-files',
      'scene-canvas'
    ])
    expect(history.entries.every((entry) => entry.state === '已提交')).toBe(true)
    const head = await git.resolveRef({ fs, dir: world.projectRoot, ref: 'HEAD' })
    const published = await git.readCommit({ fs, dir: world.projectRoot, oid: head })
    const changed = await git.walk({
      fs,
      dir: world.projectRoot,
      trees: [git.TREE({ ref: published.commit.parent[0] }), git.TREE({ ref: head })],
      map: async (filepath, [before, after]) => {
        if (!before && !after) return
        if (
          (before && (await before.type()) === 'tree') ||
          (after && (await after.type()) === 'tree')
        ) {
          return
        }
        const beforeOid = before ? await before.oid() : null
        const afterOid = after ? await after.oid() : null
        return beforeOid === afterOid ? undefined : filepath
      }
    })
    expect(changed.filter((path) => path !== undefined)).toEqual([
      arrangementPath('scene-1', 'canvas-1')
    ])
    expect(imported.failedFiles).toEqual([])
    const sourceId = imported.importedFiles[0]?.sourceId
    expect(sourceId).toBeTruthy()
    await expect(
      readFile(join(world.projectRoot, documentBodyPath(sourceId ?? '', 'md')), 'utf8')
    ).resolves.toBe('正文')
    await expect(
      readFile(join(world.projectRoot, arrangementPath('scene-1', 'canvas-1')), 'utf8')
    ).resolves.toContain('canvas-1')
    await expect(
      stranger.versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    ).rejects.toMatchObject({ code: 4101 })
  })

  it('未登记工程不能因装配而报告文件或画布保存成功', async () => {
    const world = await registeredProject()
    const services = createProjectServices({
      userDirectory: world.userDirectory,
      dialogs: dialogs(),
      logger
    })

    await expect(
      services.projectFiles.importProjectFiles({
        projectId: 'missing-project',
        expectedCatalogVersion: 'catalog-v1',
        localFilePaths: [world.sourceFile],
        parentFolderId: null
      })
    ).rejects.toMatchObject({ code: 1209 })
    await expect(
      services.sceneCanvas.saveSceneCanvasArrangement({
        projectId: 'missing-project',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'manual',
        arrangement: emptyArrangement('missing-project')
      })
    ).rejects.toMatchObject({ code: 1209 })
    await expect(readFile(join(world.projectRoot, 'assets/笔记.md'), 'utf8')).rejects.toThrow()
    await expect(
      services.versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    ).resolves.toEqual({ entries: [], nextCursor: null })
  })

  it('生成装配沿用同一登记工程，不能证明的候选不报告提交成功', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'game/scene/start.txt'), '原稿')
    const services = createProjectServices({
      userDirectory: world.userDirectory,
      dialogs: dialogs(),
      logger
    })
    const versions = new SceneVersionGatewayImpl(services.versioning, {
      ensureProjectWorkspace: async () => {
        throw new Error('版本装配测试不启动工作区核对')
      }
    })
    const source = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: world.projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    }
    const baseline = await versions.readBaseline(source)

    await expect(
      versions.commitCandidate(
        { operationId: 'generation-1', source, baseline } as SceneGenerationExecution,
        { candidateSnapshotId: 'snapshot-1', assetChanges: [] },
        () => undefined
      )
    ).rejects.toMatchObject({ code: 5302 })
    await expect(readFile(join(world.projectRoot, 'game/scene/start.txt'), 'utf8')).resolves.toBe(
      '原稿'
    )
    await expect(
      services.versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    ).resolves.toEqual({ entries: [], nextCursor: null })
  })
})

function dialogs(): ProjectFileDialogGateway {
  return {
    selectDirectory: async () => null,
    takeSaveLocation: async () => null,
    chooseSaveLocation: async () => null,
    clearSaveLocation: () => undefined
  }
}

function emptyArrangement(projectId: string): SceneCanvasArrangementVO {
  return {
    projectId,
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [],
    relations: []
  }
}

async function registeredProject(): Promise<{
  root: string
  userDirectory: string
  projectRoot: string
  sourceFile: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-version-bootstrap-'))
  directories.push(root)
  const userDirectory = join(root, 'app')
  const projectRoot = join(root, 'project')
  const sourceFile = join(root, '笔记.md')
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-seed' })}\n`
  )
  await writeFile(
    join(projectRoot, '.opengalgame/project.json'),
    `${JSON.stringify({
      id: 'project-1',
      name: '作品',
      synopsis: '',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })}\n`
  )
  await writeFile(join(projectRoot, 'game/scene/start.txt'), '')
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    `${JSON.stringify({ scenes: [{ sceneId: 'scene-1', lockState: 'unlocked' }] })}\n`
  )
  await writeFile(sourceFile, '正文')
  await git.init({ fs, dir: projectRoot, defaultBranch: 'main' })
  await git.add({ fs, dir: projectRoot, filepath: '.opengalgame/manifest.json' })
  await git.add({ fs, dir: projectRoot, filepath: '.opengalgame/project.json' })
  await git.add({ fs, dir: projectRoot, filepath: 'game/scene/start.txt' })
  await git.add({ fs, dir: projectRoot, filepath: '.opengalgame/scene-locks.json' })
  const author = {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: 1,
    timezoneOffset: 0
  }
  await git.commit({ fs, dir: projectRoot, message: '建立工程', author, committer: author })
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  return { root, userDirectory, projectRoot, sourceFile }
}
