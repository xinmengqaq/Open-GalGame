import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as git from 'isomorphic-git'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { SceneCanvasApplicationServiceImpl } from '@application/scene-canvas/services/impl/SceneCanvasApplicationServiceImpl'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { arrangementPath } from '@infrastructure/project-files/projectFilePaths'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalSceneCanvasArrangementPersistenceGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { LocalSceneCanvasWorkVersionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasWorkVersionGatewayImpl'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('场景画布版本窄端口', () => {
  it('先落盘的编排可以形成只含声明路径的作品提交', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'keep.txt'), '保留')
    const versioning = versioningFor(world.userDirectory, [
      'op-dirty',
      'hist-dirty',
      'op-dirty-2',
      'hist-dirty-2'
    ])
    await versioning.initializeBaseline({ projectId: 'project-1', initialPaths: ['keep.txt'] })
    const head = await headOf(world.projectRoot)
    const store = persistence(world.projectRoot)
    await store.writeArrangement(arrangement())
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    const before = await readFile(join(world.projectRoot, relativePath))
    const versions = canvasVersions(versioning, world.projectRoot)

    await expect(
      versions.keepArrangement(keepRequest('caller-dirty', 'periodic'))
    ).resolves.toEqual({ state: 'kept' })
    const committed = await headOf(world.projectRoot)
    expect(committed).not.toBe(head)
    await expect(readFile(join(world.projectRoot, relativePath))).resolves.toEqual(before)
    expect(await changedPaths(world.projectRoot, committed)).toEqual([relativePath])
    const blob = await git.readBlob({
      fs,
      dir: world.projectRoot,
      oid: committed,
      filepath: relativePath
    })
    expect(Buffer.from(blob.blob)).toEqual(before)
    await expect(
      versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    ).resolves.toMatchObject({ entries: [{ historyId: 'hist-dirty', state: '已提交' }] })

    const service = canvasService(store, versions, 'caller-dirty-save')
    const saved: void = await service.saveSceneCanvasArrangement(saveRequest('manual'))
    expect(saved).toBeUndefined()
    expect(await headOf(world.projectRoot)).toBe(committed)
    await expect(
      versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    ).resolves.toMatchObject({ entries: [{ historyId: 'hist-dirty' }] })
    await expect(versions.readSettlement('caller-dirty')).resolves.toEqual({ state: 'kept' })
  })

  it('已在作品修订中的编排可以保持，保存成功仍没有版本字段', async () => {
    const world = await registeredProject()
    const versioning = versioningFor(world.userDirectory, [
      'op-kept',
      'hist-kept',
      'op-kept-2',
      'hist-kept-2'
    ])
    const store = persistence(world.projectRoot)
    await store.writeArrangement(arrangement())
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [arrangementPath('scene-1', 'canvas-1')]
    })
    const head = await headOf(world.projectRoot)
    const versions = canvasVersions(versioning, world.projectRoot)

    await expect(versions.keepArrangement(keepRequest('caller-kept', 'manual'))).resolves.toEqual({
      state: 'kept'
    })
    expect(await headOf(world.projectRoot)).toBe(head)
    await expect(versioning.listHistory({ projectId: 'project-1', pageSize: 10 })).resolves.toEqual(
      { entries: [], nextCursor: null }
    )
    await expect(versions.readSettlement('caller-kept')).resolves.toEqual({ state: 'kept' })

    const service = canvasService(store, versions, 'caller-kept-save')
    const saved: void = await service.saveSceneCanvasArrangement(saveRequest('beforeGeneration'))
    expect(saved).toBeUndefined()
    expect(await headOf(world.projectRoot)).toBe(head)
  })

  it('没有作品基线时失败，并且不建立仓库', async () => {
    const world = await registeredProject()
    const versioning = versioningFor(world.userDirectory, ['op-missing', 'op-missing-save'])
    const store = persistence(world.projectRoot)
    await store.writeArrangement(arrangement())
    const versions = canvasVersions(versioning, world.projectRoot)

    await expect(
      versions.keepArrangement(keepRequest('caller-missing', 'manual'))
    ).resolves.toEqual({ state: 'failed' })
    await expect(access(join(world.projectRoot, '.git'))).rejects.toThrow()
    const before = await readFile(join(world.projectRoot, arrangementPath('scene-1', 'canvas-1')))
    const changed = arrangement()
    changed.viewport = { x: 9, y: 9, zoom: 2 }
    await expect(
      canvasService(store, versions, 'caller-missing-save', false).saveSceneCanvasArrangement({
        ...saveRequest('manual'),
        arrangement: changed
      })
    ).rejects.toMatchObject({ code: ProjectErrorCodes.workspaceNotReady })
    expect(await readFile(join(world.projectRoot, arrangementPath('scene-1', 'canvas-1')))).toEqual(
      before
    )
    await expect(access(join(world.projectRoot, '.git'))).rejects.toThrow()
  })

  it('前置检查失败和结算不明都不把编排报成已保持', async () => {
    const world = await registeredProject()
    const versioning = versioningFor(world.userDirectory, ['op-pre', 'hist-pre'])
    const store = persistence(world.projectRoot)
    await store.writeArrangement(arrangement())
    const relativePath = arrangementPath('scene-1', 'canvas-1')
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [relativePath]
    })
    const head = await headOf(world.projectRoot)
    const realCommit = versioning.commitOperation.bind(versioning)
    versioning.commitOperation = (request, requirePreconditions) =>
      realCommit(request, async () => {
        await writeFile(join(world.projectRoot, relativePath), '已在提交前被换掉')
        await requirePreconditions()
      })
    const versions = canvasVersions(versioning, world.projectRoot)

    await expect(versions.keepArrangement(keepRequest('caller-pre', 'manual'))).resolves.toEqual({
      state: 'failed'
    })
    expect(await headOf(world.projectRoot)).toBe(head)

    const unclear = canvasVersions(
      {
        prepareOperation: async () => ({
          operationId: 'version-unclear',
          baselineRef: 'baseline-1',
          revisionRef: 'a'.repeat(40)
        }),
        readPreparedOperation: async () => ({
          operationId: 'version-unclear',
          baselineRef: 'baseline-1',
          revisionRef: 'a'.repeat(40)
        }),
        bindCallerOperation: async () => undefined,
        readCallerOperation: async () => null,
        findCallerOperation: async () => null,
        commitOperation: async (_request, requirePreconditions) => {
          await requirePreconditions()
          throw new AppException({
            code: ProjectVersioningErrorCodes.insufficientEvidence,
            msg: '提交结果不明，不能重试'
          })
        },
        readOperationSettlement: async () => ({
          operationId: 'caller-unclear',
          state: '待核对'
        })
      } as ProjectVersioningApplicationService,
      world.projectRoot
    )
    await expect(unclear.keepArrangement(keepRequest('caller-unclear', 'manual'))).resolves.toEqual(
      { state: 'unknown' }
    )
    await expect(unclear.readSettlement('caller-unclear')).resolves.toEqual({ state: 'unknown' })
    await expect(unclear.readSettlement('never-seen')).resolves.toEqual({ state: 'unknown' })
    expect(await headOf(world.projectRoot)).toBe(head)
  })

  it('同一调用方身份在新进程仍读到已保持，换工程或内容则不明且不重提', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'keep.txt'), '保留')
    const versioning = versioningFor(world.userDirectory, ['op-canvas-bind', 'hist-canvas-bind'])
    await versioning.initializeBaseline({ projectId: 'project-1', initialPaths: ['keep.txt'] })
    const store = persistence(world.projectRoot)
    await store.writeArrangement(arrangement())
    const versions = canvasVersions(versioning, world.projectRoot)
    await expect(versions.keepArrangement(keepRequest('caller-canvas', 'manual'))).resolves.toEqual(
      { state: 'kept' }
    )
    const head = await headOf(world.projectRoot)

    const restarted = canvasVersions(
      versioningFor(world.userDirectory, ['op-canvas-unused', 'hist-canvas-unused']),
      world.projectRoot
    )
    await expect(restarted.readSettlement('caller-canvas')).resolves.toEqual({ state: 'kept' })
    await expect(
      restarted.keepArrangement(keepRequest('caller-canvas', 'manual'))
    ).resolves.toEqual({ state: 'kept' })
    expect(await headOf(world.projectRoot)).toBe(head)
    await expect(versioning.listHistory({ projectId: 'project-1', pageSize: 10 })).resolves.toEqual(
      { entries: [expect.objectContaining({ historyId: 'hist-canvas-bind' })], nextCursor: null }
    )

    const other = keepRequest('caller-canvas', 'manual')
    other.canvasId = 'canvas-2'
    await expect(restarted.keepArrangement(other)).resolves.toEqual({ state: 'failed' })
    await expect(restarted.readSettlement('caller-canvas')).resolves.toEqual({ state: 'kept' })
    await expect(restarted.readSettlement('never-seen')).resolves.toEqual({ state: 'unknown' })
    expect(await headOf(world.projectRoot)).toBe(head)
  })
})

function arrangement(): SceneCanvasArrangementVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 1, y: 2, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '设定',
        summary: '',
        layout: { x: 0, y: 0, width: 100, height: 80 }
      }
    ],
    relations: []
  }
}

function keepRequest(
  operationId: string,
  reason: 'manual' | 'periodic' | 'beforeGeneration'
): {
  projectId: string
  sceneId: string
  canvasId: string
  reason: 'manual' | 'periodic' | 'beforeGeneration'
  arrangement: SceneCanvasArrangementVO
  operationId: string
} {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    reason,
    arrangement: arrangement(),
    operationId
  }
}

function saveRequest(reason: 'manual' | 'beforeGeneration'): {
  projectId: string
  sceneId: string
  canvasId: string
  reason: 'manual' | 'beforeGeneration'
  arrangement: SceneCanvasArrangementVO
} {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    reason,
    arrangement: arrangement()
  }
}

function persistence(projectRoot: string): LocalSceneCanvasArrangementPersistenceGatewayImpl {
  return new LocalSceneCanvasArrangementPersistenceGatewayImpl(async (projectId) => ({
    projectId,
    directory: projectRoot
  }))
}

function canvasVersions(
  versioning: ProjectVersioningApplicationService,
  projectRoot: string
): LocalSceneCanvasWorkVersionGatewayImpl {
  return new LocalSceneCanvasWorkVersionGatewayImpl(versioning, async (projectId) => ({
    projectId,
    directory: projectRoot
  }))
}

function canvasService(
  store: LocalSceneCanvasArrangementPersistenceGatewayImpl,
  versions: LocalSceneCanvasWorkVersionGatewayImpl,
  operationId: string,
  ready = true
): SceneCanvasApplicationServiceImpl {
  return new SceneCanvasApplicationServiceImpl({
    sources: {
      readProjectInputSources: () => Promise.reject(new Error('保存不应读取来源'))
    },
    persistence: store,
    versions,
    workspace: {
      inspectProjectWorkspace: async () => ({
        ready,
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    },
    nextId: () => operationId
  })
}

async function registeredProject(): Promise<{ userDirectory: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-canvas-version-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(projectRoot)
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame', 'manifest.json'),
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-1' }, null, 2)}\n`
  )
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  return { userDirectory, projectRoot }
}

function versioningFor(
  userDirectory: string,
  ids: readonly string[]
): ProjectVersioningApplicationServiceImpl {
  const remaining = [...ids]
  return new ProjectVersioningApplicationServiceImpl({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => {
      const next = remaining.shift()
      if (!next) throw new Error('测试身份已用尽')
      return next
    }
  })
}

function headOf(projectRoot: string): Promise<string> {
  return git.resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })
}

async function changedPaths(projectRoot: string, revisionRef: string): Promise<string[]> {
  const published = await git.readCommit({ fs, dir: projectRoot, oid: revisionRef })
  const changed = await git.walk({
    fs,
    dir: projectRoot,
    trees: [git.TREE({ ref: published.commit.parent[0] }), git.TREE({ ref: revisionRef })],
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
  return changed.filter((path): path is string => path !== undefined)
}
