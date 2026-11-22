import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  SceneGenerationBaseline,
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { SceneGenerationVersionConflict } from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { SceneVersionGatewayImpl } from '@infrastructure/scene-generation/versions/SceneVersionGatewayImpl'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { readStageOids } from '@infrastructure/git/repository/WorkBaseline'
import { applyTreeEdits } from '@infrastructure/git/objects/gitTree'
import { realGitEffects, type GitEffects } from '@infrastructure/git/gitEffects'
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

  it('无关修订前进不使候选失效，确认只把目标脚本合入当前作品', async () => {
    const world = await registeredScene()
    const sidePath = 'game/scene/side.txt'
    const versioning = versioningFor(world.userDirectory, ['op-unrelated', 'hist-unrelated'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json', sidePath]
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const running = execution(world, await gateway.readBaseline(world.source))
    const revisionId = await storedCandidate(world, running)
    const unrelated = await commitOutside(world.projectRoot, sidePath, '旁路确认')

    await expect(gateway.inspectBaseline(running)).resolves.toEqual({
      baselineState: 'unchanged',
      lockState: 'unlocked'
    })
    const committed = await gateway.commitCandidate(
      running,
      candidate(revisionId),
      () => undefined
    )

    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')
    await expect(readFile(join(world.projectRoot, sidePath), 'utf8')).resolves.toBe('旁路确认')
    const published = await git.readCommit({ fs, dir: world.projectRoot, oid: committed.commitId })
    expect(published.commit.parent).toEqual([unrelated])
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
  })

  it('目标脚本的工作区改动仍阻止覆盖', async () => {
    const world = await prepareCandidateWorld()
    await writeFile(join(world.projectRoot, scriptPath), '人工改动')

    await expect(world.gateway.inspectBaseline(world.running)).resolves.toMatchObject({
      baselineState: 'changed'
    })
    await expect(
      world.gateway.commitCandidate(world.running, candidate(world.revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('人工改动')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('目标脚本只暂存未提交改动也阻止覆盖', async () => {
    const world = await prepareCandidateWorld()
    await writeFile(join(world.projectRoot, scriptPath), '暂存改动')
    await git.add({ fs, dir: world.projectRoot, filepath: scriptPath })
    await writeFile(join(world.projectRoot, scriptPath), '原稿')

    await expect(world.gateway.inspectBaseline(world.running)).resolves.toMatchObject({
      baselineState: 'changed'
    })
    await expect(
      world.gateway.commitCandidate(world.running, candidate(world.revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('目标脚本缺失仍阻止覆盖', async () => {
    const world = await prepareCandidateWorld()
    await rm(join(world.projectRoot, scriptPath))

    await expect(world.gateway.inspectBaseline(world.running)).resolves.toMatchObject({
      baselineState: 'changed'
    })
    await expect(
      world.gateway.commitCandidate(world.running, candidate(world.revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('旧持久候选按生成时修订核对目标文件，无关提交不影响且确认可合入', async () => {
    const world = await registeredScene()
    const sidePath = 'game/scene/side.txt'
    const versioning = versioningFor(world.userDirectory, ['op-legacy', 'hist-legacy'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json', sidePath]
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const current = await gateway.readBaseline(world.source)
    const legacy = {
      ...current,
      affectedFiles: [{ relativePath: scriptPath, digest: current.commitId }]
    }
    const running = execution(world, legacy)
    const revisionId = await storedCandidate(world, running)
    const unrelated = await commitOutside(world.projectRoot, sidePath, '旧候选旁路')

    await expect(gateway.inspectBaseline(running)).resolves.toMatchObject({
      baselineState: 'unchanged'
    })
    const restarted = new SceneVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-legacy-restart', 'hist-legacy-restart']),
      unusedProjects
    )
    const committed = await restarted.commitCandidate(
      running,
      candidate(revisionId),
      () => undefined
    )
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')
    await expect(readFile(join(world.projectRoot, sidePath), 'utf8')).resolves.toBe('旧候选旁路')
    const published = await git.readCommit({ fs, dir: world.projectRoot, oid: committed.commitId })
    expect(published.commit.parent).toEqual([unrelated])
  })

  it('旧持久候选的目标文件在后续提交中被改动时仍拒绝覆盖', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-legacy-hit', 'hist-legacy-hit'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const current = await gateway.readBaseline(world.source)
    const running = execution(world, {
      ...current,
      affectedFiles: [{ relativePath: scriptPath, digest: current.commitId }]
    })
    const revisionId = await storedCandidate(world, running)
    await commitOutside(world.projectRoot, scriptPath, '后续提交')

    await expect(gateway.inspectBaseline(running)).resolves.toMatchObject({
      baselineState: 'changed'
    })
    await expect(
      gateway.commitCandidate(running, candidate(revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('后续提交')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('提交边界内无关修订前进仍合入，不清除并发改动', async () => {
    const world = await registeredScene()
    const sidePath = 'game/scene/side.txt'
    const versioning = versioningFor(world.userDirectory, ['op-race-side', 'hist-race-side'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json', sidePath]
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const running = execution(world, await gateway.readBaseline(world.source))
    const revisionId = await storedCandidate(world, running)
    const realCommit = versioning.commitOperation.bind(versioning)
    let concurrent: string | undefined
    versioning.commitOperation = async (request, requirePreconditions) =>
      realCommit(request, async () => {
        concurrent ??= await commitOutside(world.projectRoot, sidePath, '边界旁路')
        await requirePreconditions()
      })

    const committed = await gateway.commitCandidate(
      running,
      candidate(revisionId),
      () => undefined
    )
    expect(concurrent).toBeTruthy()
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')
    await expect(readFile(join(world.projectRoot, sidePath), 'utf8')).resolves.toBe('边界旁路')
    const published = await git.readCommit({ fs, dir: world.projectRoot, oid: committed.commitId })
    expect(published.commit.parent).toEqual([concurrent])
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
  })

  it('发布前分支真实前进后抛错时补偿并重试，保留旁路提交与无关暂存', async () => {
    const world = await registeredScene()
    const sidePath = 'game/scene/side.txt'
    const stagedPath = 'game/scene/staged.txt'
    let concurrent: string | undefined
    let branchAttempts = 0
    const effects: GitEffects = {
      ...realGitEffects,
      updateBranch: async (projectRoot, branchRef, oid, expectedOid) => {
        branchAttempts += 1
        if (branchAttempts === 1) {
          concurrent = await commitOutsideWithoutIndex(projectRoot, sidePath, '发布前旁路')
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '模拟发布前分支已被其他修订推进'
          })
        }
        return realGitEffects.updateBranch(projectRoot, branchRef, oid, expectedOid)
      }
    }
    const versioning = versioningFor(
      world.userDirectory,
      ['op-cas-race', 'hist-cas-race'],
      effects
    )
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json', sidePath]
    })
    await writeFile(join(world.projectRoot, stagedPath), '无关暂存')
    await git.add({ fs, dir: world.projectRoot, filepath: stagedPath })
    const stagedBefore = (await readStageOids(world.projectRoot, [stagedPath])).get(stagedPath)
    expect(stagedBefore).toBeTruthy()
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const running = execution(world, await gateway.readBaseline(world.source))
    const revisionId = await storedCandidate(world, running)

    const committed = await gateway.commitCandidate(
      running,
      candidate(revisionId),
      () => undefined
    )

    expect(branchAttempts).toBe(2)
    expect(concurrent).toBeTruthy()
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('确认稿')
    await expect(readFile(join(world.projectRoot, sidePath), 'utf8')).resolves.toBe('发布前旁路')
    await expect(readFile(join(world.projectRoot, stagedPath), 'utf8')).resolves.toBe('无关暂存')
    expect((await readStageOids(world.projectRoot, [stagedPath])).get(stagedPath)).toBe(
      stagedBefore
    )
    await expect(
      git.readBlob({ fs, dir: world.projectRoot, oid: committed.commitId, filepath: stagedPath })
    ).rejects.toThrow()
    const published = await git.readCommit({ fs, dir: world.projectRoot, oid: committed.commitId })
    expect(published.commit.parent).toEqual([concurrent])
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
  })

  it('候选生成时修订不在当前历史中时，内容相同也拒绝合入', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-orphan', 'hist-orphan'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const running = execution(world, await gateway.readBaseline(world.source))
    const revisionId = await storedCandidate(world, running)
    await rewriteHistoryWithSameTree(world.projectRoot)

    await expect(gateway.inspectBaseline(running)).resolves.toMatchObject({
      baselineState: 'unchanged'
    })
    await expect(
      gateway.commitCandidate(running, candidate(revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('提交边界内目标脚本只被暂存时也拒绝覆盖', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-race-stage', 'hist-race-stage'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const running = execution(world, await gateway.readBaseline(world.source))
    const revisionId = await storedCandidate(world, running)
    const realCommit = versioning.commitOperation.bind(versioning)
    let staged = false
    versioning.commitOperation = async (request, requirePreconditions) =>
      realCommit(request, async () => {
        if (!staged) {
          staged = true
          await writeFile(join(world.projectRoot, scriptPath), '边界暂存')
          await git.add({ fs, dir: world.projectRoot, filepath: scriptPath })
          await writeFile(join(world.projectRoot, scriptPath), '原稿')
        }
        await requirePreconditions()
      })

    await expect(
      gateway.commitCandidate(running, candidate(revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    expect(staged).toBe(true)
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('原稿')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
    const stageOid = (
      await readStageOids(world.projectRoot, [scriptPath])
    ).get(scriptPath)
    expect(stageOid).toBeTruthy()
    const stagedBlob = await git.readBlob({ fs, dir: world.projectRoot, oid: stageOid! })
    expect(Buffer.from(stagedBlob.blob).toString()).toBe('边界暂存')
  })

  it('提交边界内目标脚本被改动时拒绝覆盖且不产生候选提交', async () => {
    const world = await registeredScene()
    const versioning = versioningFor(world.userDirectory, ['op-race-target', 'hist-race-target'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
    })
    const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
    const running = execution(world, await gateway.readBaseline(world.source))
    const revisionId = await storedCandidate(world, running)
    const realCommit = versioning.commitOperation.bind(versioning)
    let concurrent: string | undefined
    versioning.commitOperation = async (request, requirePreconditions) =>
      realCommit(request, async () => {
        concurrent ??= await commitOutside(world.projectRoot, scriptPath, '边界改动')
        await requirePreconditions()
      })

    await expect(
      gateway.commitCandidate(running, candidate(revisionId), () => undefined)
    ).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    expect(concurrent).toBeTruthy()
    await expect(readFile(join(world.projectRoot, scriptPath), 'utf8')).resolves.toBe('边界改动')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    const messages = (await git.log({ fs, dir: world.projectRoot })).map(
      (entry) => entry.commit.message
    )
    expect(messages.some((message) => message.includes('确认场景生成'))).toBe(false)
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
  ids: readonly string[],
  effects?: GitEffects
): ManageProjectVersioning {
  let cursor = 0
  return new ManageProjectVersioning({
    ...createProjectVersioningGateways(userDirectory, effects),
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

interface TestSceneWorld {
  userDirectory: string
  projectRoot: string
  source: SceneSourceLocation
}

async function registeredScene(): Promise<TestSceneWorld> {
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
  source: SceneSourceLocation
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

async function prepareCandidateWorld(): Promise<
  TestSceneWorld & {
    gateway: SceneVersionGatewayImpl
    running: SceneGenerationExecution
    revisionId: string
  }
> {
  const world = await registeredScene()
  const versioning = versioningFor(world.userDirectory, ['op-target', 'hist-target'])
  await versioning.initializeBaseline({
    projectId: 'project-1',
    initialPaths: [scriptPath, '.opengalgame/scene-locks.json']
  })
  const gateway = new SceneVersionGatewayImpl(versioning, unusedProjects)
  const running = execution(world, await gateway.readBaseline(world.source))
  const revisionId = await storedCandidate(world, running)
  return { ...world, gateway, running, revisionId }
}

async function storedCandidate(
  world: TestSceneWorld,
  running: SceneGenerationExecution,
  content = '确认稿'
): Promise<string> {
  const files = new AiProjectFileSystemImpl(world.userDirectory)
  const workspace = await files.createWorkspace({
    projectId: running.projectId,
    threadId: running.threadId,
    operationId: running.operationId,
    projectRoot: world.projectRoot,
    sourcePaths: [scriptPath]
  })
  await files.writeFile(workspace, scriptPath, new TextEncoder().encode(content))
  const revision = await files.saveRevision(workspace)
  await files.discardWorkspace(workspace)
  return revision.revisionId
}

async function commitOutside(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<string> {
  const absolute = join(projectRoot, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
  await git.add({ fs, dir: projectRoot, filepath: relativePath })
  const author = testAuthor()
  return git.commit({
    fs,
    dir: projectRoot,
    message: `外部提交 ${relativePath}\n`,
    author,
    committer: author
  })
}

async function commitOutsideWithoutIndex(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<string> {
  const absolute = join(projectRoot, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
  const head = await git.readCommit({
    fs,
    dir: projectRoot,
    oid: await git.resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })
  })
  const written = await applyTreeEdits({ dir: projectRoot }, head.commit.tree, [
    { relativePath, action: 'upsert', bytes: new TextEncoder().encode(content) }
  ])
  const author = testAuthor()
  const commitId = await git.writeCommit({
    fs,
    dir: projectRoot,
    commit: {
      message: `外部提交 ${relativePath}\n`,
      tree: written.treeOid,
      parent: [await git.resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })],
      author,
      committer: author
    }
  })
  await pointBranch(projectRoot, commitId)
  return commitId
}

async function rewriteHistoryWithSameTree(projectRoot: string): Promise<void> {
  const head = await git.readCommit({
    fs,
    dir: projectRoot,
    oid: await git.resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })
  })
  const author = testAuthor()
  const orphan = await git.writeCommit({
    fs,
    dir: projectRoot,
    commit: {
      message: '重写作品历史\n',
      tree: head.commit.tree,
      parent: [],
      author,
      committer: author
    }
  })
  await pointBranch(projectRoot, orphan)
}

async function pointBranch(projectRoot: string, commitId: string): Promise<void> {
  const branch = await git.currentBranch({ fs, dir: projectRoot, fullname: true })
  if (!branch) throw new Error('测试工程没有当前分支')
  await git.writeRef({ fs, dir: projectRoot, ref: branch, value: commitId, force: true })
}

function testAuthor(): {
  name: string
  email: string
  timestamp: number
  timezoneOffset: number
} {
  return {
    name: 'tester',
    email: 'tester@localhost',
    timestamp: 1_700_000_000,
    timezoneOffset: 0
  }
}

function lockFile(lockState: 'locked' | 'unlocked'): string {
  return JSON.stringify({ scenes: [{ sceneId: 'scene-1', lockState }] })
}

function execution(
  world: { source: SceneSourceLocation },
  baseline: SceneGenerationBaseline
): SceneGenerationExecution {
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
