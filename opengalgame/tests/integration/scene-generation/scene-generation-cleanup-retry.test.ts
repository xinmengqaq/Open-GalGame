/**
 * 包 A：正式提交后清理待处理的真实生产重试入口。
 *
 * 走公开 controller/client，不重开生成；只核对补清理、commitId、提交数和其它操作工作区。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { SceneGenerationServices } from '@bootstrap/sceneGeneration'
import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const access = { trusted: true, requestId: 'cleanup-retry-test' }

afterEach(() => {
  vi.restoreAllMocks()
})

function logger(): LoggerGateway {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
}

function controllerFor(app: SceneGenerationServices): SceneGenerationController {
  return new SceneGenerationController(
    {
      launch: app.launch,
      renderQuery: app.renderQuery,
      control: app.control,
      history: app.history,
      preview: app.candidatePreview,
      generation: app.generation
    } as unknown as SceneGenerationApplicationGateway,
    new IpcExceptionHandler(logger(), new IpcErrorMapper())
  )
}

function clientFor(controller: SceneGenerationController): SceneGenerationClientImpl {
  return new SceneGenerationClientImpl({
    resumeSceneGeneration: (value: unknown) => controller.resume(value, access)
  } as unknown as DesktopBridge)
}

async function readExecution(
  app: SceneGenerationServices,
  scope: SceneGenerationScopeDTO
): Promise<SceneGenerationExecution> {
  const execution = await app.ports.executions.readExecution(scope)
  if (!execution) throw new Error('执行记录不存在')
  return execution
}

function workspaceRoot(
  userStateRoot: string,
  execution: Pick<SceneGenerationExecution, 'projectId' | 'threadId' | 'operationId'>
): string {
  return join(
    userStateRoot,
    'ai',
    'projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'workspaces',
    execution.operationId
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function officialFacts(base: GenerationFixture): Promise<{
  entry: string
  head: string
  commits: number
}> {
  return {
    entry: await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8'),
    head: base.git('rev-parse', 'HEAD'),
    commits: Number(base.git('rev-list', '--count', 'HEAD'))
  }
}

it('[I1] 已提交且两类清理待处理：公开入口幂等补清理，不再次提交也不动其它工作区', async () => {
  const base = await generationFixture()
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const reviewed = await readExecution(base.app, request)
  const discard = vi
    .spyOn(base.app.ports.workspace, 'discardWorkspace')
    .mockRejectedValueOnce(new Error('workspace cleanup unavailable'))
  const boundary = vi
    .spyOn(base.app.ports.workflow, 'clearPauseBoundary')
    .mockRejectedValueOnce(new Error('boundary cleanup unavailable'))
  await base.app.generation.replySceneGenerationInteraction({
    ...reviewed,
    interactionId: reviewed.interaction!.interactionId,
    checkpointId: reviewed.checkpointId!,
    candidateSnapshotId: reviewed.candidateSnapshotId!,
    replyId: 'accept-before-cleanup-retry',
    reply: { kind: 'accept' }
  })
  await base.run().catch(() => undefined)

  const committed = await readExecution(base.app, request)
  expect(committed.state).toBe('succeeded')
  expect(committed.result?.commitId).toBeDefined()
  expect(committed.workspaceCleanupPending).toBe(true)
  expect(committed.pauseBoundaryCleanupPending).toBe(true)
  expect(committed.failure?.message).toContain('作品已保存')
  expect(discard).toHaveBeenCalledTimes(1)
  expect(boundary).toHaveBeenCalledTimes(1)
  const official = await officialFacts(base)
  const operationsBefore = (
    await base.app.ports.executions.listSceneExecutions({
      projectId: request.projectId,
      sceneId: request.sceneId,
      limit: 100
    })
  ).length
  const modelCallsBefore = base.bodies.length

  const sibling = workspaceRoot(base.config.userStateRoot, {
    ...committed,
    operationId: 'sibling-operation'
  })
  const siblingEntry = join(sibling, 'game/scene/start.txt')
  await mkdir(join(sibling, 'game/scene'), { recursive: true })
  await writeFile(siblingEntry, 'say:别的操作的草稿;', 'utf8')

  const client = clientFor(controllerFor(base.app))
  const identity = {
    projectId: committed.projectId,
    sceneId: committed.sceneId,
    operationId: committed.operationId,
    threadId: committed.threadId,
    branchId: committed.branchId
  }

  // 第一次重试仍失败：保留已提交结果和待清理事实，不产生第二次提交。
  discard.mockRejectedValueOnce(new Error('workspace still unavailable'))
  boundary.mockRejectedValueOnce(new Error('boundary still unavailable'))
  await expect(client.retryCleanup(identity)).resolves.toMatchObject({
    code: ErrorCodes.internalError
  })
  const stillPending = await readExecution(base.app, request)
  expect(stillPending.state).toBe('succeeded')
  expect(stillPending.result?.commitId).toBe(committed.result!.commitId)
  expect(stillPending.workspaceCleanupPending).toBe(true)
  expect(stillPending.pauseBoundaryCleanupPending).toBe(true)
  expect(await officialFacts(base)).toEqual(official)
  expect(await exists(siblingEntry)).toBe(true)

  const retried = await client.retryCleanup(identity)
  expect(retried).toMatchObject({
    code: ErrorCodes.success,
    data: {
      state: 'succeeded',
      result: { commitId: committed.result!.commitId }
    }
  })
  expect(retried.data?.cleanupPending).toBeUndefined()
  expect(retried.data?.canRetryCleanup).toBeUndefined()

  const cleaned = await readExecution(base.app, request)
  expect(cleaned.state).toBe('succeeded')
  expect(cleaned.result?.commitId).toBe(committed.result!.commitId)
  expect(cleaned.workspaceCleanupPending).toBe(false)
  expect(cleaned.pauseBoundaryCleanupPending).toBe(false)
  expect(cleaned.failure).toBeUndefined()
  expect(await exists(workspaceRoot(base.config.userStateRoot, cleaned))).toBe(false)
  expect(await readFile(siblingEntry, 'utf8')).toBe('say:别的操作的草稿;')
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  expect(discard).toHaveBeenCalledTimes(3)
  expect(boundary).toHaveBeenCalledTimes(3)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect(
    (
      await base.app.ports.executions.listSceneExecutions({
        projectId: request.projectId,
        sceneId: request.sceneId,
        limit: 100
      })
    ).length
  ).toBe(operationsBefore)
  const cleanupCalls = { discard: discard.mock.calls.length, boundary: boundary.mock.calls.length }

  // 幂等：没有待清理事实时再次请求只返回当前成功状态，不再删除/清理或写记录。
  await expect(client.retryCleanup(identity)).resolves.toMatchObject({
    code: ErrorCodes.success,
    data: { state: 'succeeded', result: { commitId: committed.result!.commitId } }
  })
  expect(discard.mock.calls.length).toBe(cleanupCalls.discard)
  expect(boundary.mock.calls.length).toBe(cleanupCalls.boundary)
  expect(await readExecution(base.app, request)).toEqual(cleaned)
  expect(await officialFacts(base)).toEqual(official)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect(base.jobs).toHaveLength(0)
})
