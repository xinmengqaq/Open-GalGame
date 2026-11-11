import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SceneGenerationCandidate } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { SceneGenerationVersionConflict } from '@application/scene-generation/policies/SceneGenerationVersionConflict'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { SceneVersionGatewayImpl } from '@infrastructure/scene-generation/versions/SceneVersionGatewayImpl'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

const directories: string[] = []
const scriptPath = 'game/scene/start.txt'

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('场景生成版本窄端口', () => {
  it('锁定或基线前置失败时不改正式脚本', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-lock', 'hist-lock'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const baseline = await gateway.readBaseline(world.source)
    await writeFile(join(world.projectRoot, '.opengalgame/scene-locks.json'), lockFile('locked'))
    let checked = false

    await expect(
      gateway.commitCandidate(execution(world, baseline), candidate(), () => {
        checked = true
        throw new SceneGenerationVersionConflict('场景已锁定，不能覆盖')
      })
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    expect(checked).toBe(true)
  })

  it('候选来源不能证明时拒绝提交，正式脚本保持原样', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-source', 'hist-source'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const baseline = await gateway.readBaseline(world.source)
    let checked = false

    await expect(
      gateway.commitCandidate(execution(world, baseline), candidate(), () => {
        checked = true
      })
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.invalidContentFingerprint })
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    expect(checked).toBe(true)
    await expect(gateway.readOperationCommit(execution(world, baseline))).resolves.toEqual({
      state: 'unknown'
    })
  })

  it('已发布候选在新进程确认后进入作品，工作区变化不改变已保留内容', async () => {
    const world = await registeredScene()
    const files = new AiProjectFileSystemImpl(world.userDirectory)
    const running = execution(world, {
      commitId: 'pending',
      affectedFiles: [{ relativePath: scriptPath, digest: 'pending' }],
      lockState: 'unlocked'
    })
    const workspace = await files.createWorkspace({
      projectId: running.projectId,
      threadId: running.threadId,
      operationId: running.operationId,
      projectRoot: world.projectRoot,
      sourcePaths: [scriptPath]
    })
    await files.writeFile(workspace, scriptPath, new TextEncoder().encode('确认稿'))
    const revision = await files.saveRevision(workspace)
    await files.discardWorkspace(workspace)
    const versioning = versioningFor(world.userDirectory, ['op-scene-keep', 'hist-scene-keep'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const baseline = await gateway.readBaseline(world.source)
    const committed = await gateway.commitCandidate(
      { ...running, baseline },
      candidate(revision.revisionId),
      () => undefined
    )

    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')
    const restarted = new SceneVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-scene-unused', 'hist-scene-unused']),
      unusedProjects
    )
    await expect(restarted.readOperationCommit({ ...running, baseline })).resolves.toEqual({
      state: 'committed',
      commitId: committed.commitId
    })
    await files.writeFile(
      await files.restoreRevision({
        projectId: running.projectId,
        threadId: running.threadId,
        operationId: running.operationId,
        revisionId: revision.revisionId
      }),
      scriptPath,
      new TextEncoder().encode('工作区已变')
    )
    const current = await restarted.readBaseline(world.source)
    await expect(
      restarted.commitCandidate(
        { ...running, baseline: current },
        candidate(revision.revisionId),
        () => undefined
      )
    ).resolves.toEqual({ commitId: committed.commitId })
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('已提交保持已提交，结果不明保持不明且不重提', async () => {
    const committed = gatewayOver({
      operationId: 'version-op',
      state: '已提交',
      revisionRef: 'a'.repeat(40)
    })
    const executionId = execution(await idleSource(), {
      commitId: 'base',
      affectedFiles: [{ relativePath: scriptPath, digest: 'base' }],
      lockState: 'unlocked'
    })
    await expect(committed.readOperationCommit(executionId)).resolves.toEqual({
      state: 'committed',
      commitId: 'a'.repeat(40)
    })

    const world = await registeredScene()
    const unclearVersioning = versioningFor(world.userDirectory, ['op-unclear', 'hist-unclear'])
    await unclearVersioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const versioning = Object.assign(
      Object.create(Object.getPrototypeOf(unclearVersioning)),
      unclearVersioning
    ) as ProjectVersioningApplicationService
    versioning.commitOperation = async () => {
      throw new AppException({
        code: ProjectVersioningErrorCodes.insufficientEvidence,
        msg: '提交结果不明，不能重试'
      })
    }
    const unclear = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const baseline = await unclear.readBaseline(world.source)
    await expect(
      unclear.commitCandidate(execution(world, baseline), candidate(), () => undefined)
    ).rejects.toMatchObject({ code: ErrorCodes.internalError })
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    await expect(unclear.readOperationCommit(execution(world, baseline))).resolves.toEqual({
      state: 'unknown'
    })
  })

  it('同一执行换候选内容保持内容冲突，不能证明的来源不能报成功', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-conflict', 'hist-conflict'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const realCommit = versioning.commitOperation.bind(versioning)
    versioning.commitOperation = async (request, requirePreconditions) => {
      if (request.input.kind === 'candidate' && request.input.candidateRef.endsWith('\0second')) {
        throw new AppException({
          code: ProjectVersioningErrorCodes.contentFingerprintConflict,
          msg: '同一操作不能更换内容'
        })
      }
      return realCommit(request, requirePreconditions)
    }
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const baseline = await gateway.readBaseline(world.source)
    const running = execution(world, baseline)

    await expect(
      gateway.commitCandidate(running, candidate('second'), () => undefined)
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.contentFingerprintConflict })
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    await expect(
      gateway.commitCandidate(running, candidate(), () => undefined)
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.invalidContentFingerprint })
  })

  it('同一执行身份在新进程仍读到已提交，回退使用被绑定的版本，未知身份不重提', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-scene-bind', 'hist-scene-bind'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const baseline = await gateway.readBaseline(world.source)
    const running = execution(world, baseline)
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-generation',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: [scriptPath],
      watchedPaths: []
    })
    await versioning.bindCallerOperation({
      projectId: 'project-1',
      sourceModule: 'scene-generation',
      callerOperationId: running.operationId,
      operationId: prepared.operationId,
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: [scriptPath],
      watchedPaths: []
    })
    const committed = await versioning.commitOperation(
      {
        projectId: 'project-1',
        operationId: prepared.operationId,
        baselineRef: prepared.baselineRef,
        input: {
          kind: 'files',
          changes: [
            {
              relativePath: scriptPath,
              action: 'modify',
              content: { kind: 'bytes', bytes: new TextEncoder().encode('确认稿') }
            }
          ]
        },
        saveMode: 'manual',
        contentSource: 'ai',
        title: '确认场景生成',
        summary: '已确认的场景脚本进入作品'
      },
      () => undefined
    )
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')

    const restarted = new SceneVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-scene-unused', 'hist-scene-unused']),
      unusedProjects
    )
    await expect(restarted.readOperationCommit(running)).resolves.toEqual({
      state: 'committed',
      commitId: committed.revisionRef
    })
    const rolled = await restarted.rollbackCandidate(running, committed.revisionRef)
    expect(rolled.rollbackCommitId).not.toBe(committed.revisionRef)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')

    const replay = new SceneVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-scene-again', 'hist-scene-again']),
      unusedProjects
    )
    await expect(
      replay.commitCandidate(running, candidate(), () => undefined)
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    await expect(
      replay.readOperationCommit({ ...running, operationId: 'never-seen' })
    ).resolves.toEqual({ state: 'notCommitted' })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
  })
})
function gatewayOver(settlement: VersionSettlementVO): SceneVersionGatewayImpl {
  const versioning = {
    readWorkBaseline: async () => ({ baselineRef: 'baseline-1', revisionRef: 'base' }),
    prepareOperation: async () => ({
      operationId: 'version-op',
      baselineRef: 'baseline-1',
      revisionRef: 'base'
    }),
    readPreparedOperation: async () => ({
      operationId: 'version-op',
      baselineRef: 'baseline-1',
      revisionRef: 'base'
    }),
    bindCallerOperation: async () => undefined,
    readCallerOperation: async () => ({
      projectId: 'project-1',
      sourceModule: 'scene-generation',
      callerOperationId: 'caller-scene',
      operationId: 'version-op'
    }),
    findCallerOperation: async () => null,
    commitOperation: async () => {
      throw new Error('来源未固定时不应进入提交')
    },
    readOperationSettlement: async () => settlement,
    rollbackOperation: async () => {
      throw new Error('不应回退')
    }
  } as unknown as ProjectVersioningApplicationService
  return new SceneVersionGatewayImpl(versioning, unusedProjects)
}

function versioningFor(
  userDirectory: string,
  ids: readonly string[]
): ProjectVersioningApplicationServiceImpl {
  let cursor = 0
  return new ProjectVersioningApplicationServiceImpl({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => {
      const id = ids[cursor]
      cursor += 1
      if (!id) throw new Error('测试身份已用尽')
      return id
    }
  })
}

const unusedProjects = {
  ensureProjectWorkspace: async () => {
    throw new Error('版本端口测试不启动工作区核对')
  }
}

async function registeredScene(): Promise<{
  userDirectory: string
  projectRoot: string
  source: {
    projectId: string
    sceneId: string
    projectRoot: string
    sceneDirectory: string
    entryFile: string
  }
}> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-scene-version-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await writeFile(join(projectRoot, scriptPath), '原稿')
  await writeFile(join(projectRoot, '.opengalgame/scene-locks.json'), lockFile('unlocked'))
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  return {
    userDirectory,
    projectRoot,
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    }
  }
}

async function idleSource(): Promise<{
  projectRoot: string
  source: {
    projectId: string
    sceneId: string
    projectRoot: string
    sceneDirectory: string
    entryFile: string
  }
}> {
  return {
    projectRoot: 'unused',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'unused',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    }
  }
}

function lockFile(lockState: 'locked' | 'unlocked'): string {
  return JSON.stringify({ scenes: [{ sceneId: 'scene-1', lockState }] })
}

function execution(
  world: {
    source: {
      projectId: string
      sceneId: string
      projectRoot: string
      sceneDirectory: string
      entryFile: string
    }
  },
  baseline: {
    commitId: string
    affectedFiles: readonly { relativePath: string; digest?: string }[]
    lockState: 'locked' | 'unlocked' | 'unknown'
  }
): {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  fingerprint: string
  source: (typeof world)['source']
  inputSnapshot: {
    canvasId: string
    assets: []
    documents: []
    prompts: []
    fieldBindings: []
    relations: []
    confirmedControls: []
  }
  policy: { maxCorrections: number }
  reviewCandidate: boolean
  baseline: typeof baseline
  state: 'committing'
  step: 'committing'
  attempt: number
  sequence: number
  budget: {
    correctionsUsed: number
    modelCallsUsed: number
    toolCallsUsed: number
    activeElapsedMs: number
  }
  replies: []
} {
  return {
    projectId: world.source.projectId,
    sceneId: world.source.sceneId,
    operationId: 'caller-scene',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint-1',
    source: world.source,
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

function candidate(candidateSnapshotId = 'candidate-1'): SceneGenerationCandidate {
  const artifact: SceneGenerationArtifact = {
    scene: { projectId: 'project-1', sceneId: 'scene-1' },
    hasEntry: true,
    statements: []
  }
  return {
    candidateSnapshotId,
    artifact,
    preview: {
      entryFile: scriptPath,
      files: [scriptPath],
      parserVersion: 'test',
      commandLocations: [],
      assetLocations: [],
      validationReport: { issues: [] }
    },
    assetChanges: []
  }
}
