import { expect, it, vi, type Mock } from 'vitest'

import { PauseSceneGenerationUseCase } from '@application/scene-generation/services/impl/PauseSceneGenerationUseCase'
import type { SceneGenerationServiceContext } from '@application/scene-generation/services/impl/SceneGenerationServiceContext'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'

const execution = {
  projectId: 'project',
  sceneId: 'scene',
  operationId: 'operation',
  threadId: 'thread',
  branchId: 'branch',
  fingerprint: 'fingerprint',
  source: {
    projectId: 'project',
    sceneId: 'scene',
    projectRoot: 'project-root',
    sceneDirectory: 'game/scene',
    entryFile: 'start.txt'
  },
  inputSnapshot: {
    canvasId: 'canvas',
    arrangementVersion: 'version',
    assets: [],
    documents: [],
    prompts: [],
    fieldBindings: [],
    relations: [],
    confirmedControls: []
  },
  policy: { maxCorrections: 2 },
  reviewCandidate: false,
  baseline: { commitId: 'baseline', affectedFiles: [], lockState: 'unlocked' },
  state: 'running',
  step: 'generating',
  attempt: 0,
  sequence: 1,
  budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
  mode: 'generate',
  replies: []
} as unknown as SceneGenerationExecution

function contextOf(options: {
  readonly capabilities: { resume: boolean; pause: boolean; continueInteraction: boolean; fork: boolean }
  readonly active: boolean
}): {
  context: SceneGenerationServiceContext
  writeExecution: Mock
  requestPause: Mock
} {
  const writeExecution = vi.fn(async (value: SceneGenerationExecution) => ({
    execution: value,
    canContinue: false
  }))
  const requestPause = vi.fn(async () => undefined)
  const active = { execution, controller: new AbortController() }
  const context = {
    deps: {
      workflow: {
        capabilities: () => options.capabilities
      }
    },
    coordinator: {
      requireExecution: async () => execution,
      serialize: async (_key: string, operation: () => Promise<unknown>) => operation(),
      writeExecution,
      requestPause,
      activeExecutions: new Map(
        options.active ? [[JSON.stringify(['project', 'scene', 'operation']), active]] : []
      )
    }
  } as unknown as SceneGenerationServiceContext
  return { context, writeExecution, requestPause }
}

it('工作流没有暂停能力时，在写入暂停意图前拒绝', async () => {
  const { context, writeExecution, requestPause } = contextOf({
    capabilities: { resume: false, pause: false, continueInteraction: true, fork: false },
    active: true
  })

  await expect(
    new PauseSceneGenerationUseCase(context).pauseSceneGeneration({
      projectId: 'project',
      sceneId: 'scene',
      operationId: 'operation'
    })
  ).rejects.toMatchObject({
    code: 4103,
    message: '当前构建尚未启用暂停恢复，未写入暂停意图'
  })
  expect(writeExecution).not.toHaveBeenCalled()
  expect(requestPause).not.toHaveBeenCalled()
})

it('没有活动运行时拒绝暂停，不写入无法消费的暂停意图', async () => {
  const { context, writeExecution, requestPause } = contextOf({
    capabilities: { resume: true, pause: true, continueInteraction: true, fork: false },
    active: false
  })

  await expect(
    new PauseSceneGenerationUseCase(context).pauseSceneGeneration({
      projectId: 'project',
      sceneId: 'scene',
      operationId: 'operation'
    })
  ).rejects.toMatchObject({
    code: 4103,
    message: '当前没有可安全暂停的生成运行'
  })
  expect(writeExecution).not.toHaveBeenCalled()
  expect(requestPause).not.toHaveBeenCalled()
})

it('活动运行持久写入暂停意图后通知工作流在安全检查点停止', async () => {
  const { context, writeExecution, requestPause } = contextOf({
    capabilities: { resume: true, pause: true, continueInteraction: true, fork: false },
    active: true
  })

  await new PauseSceneGenerationUseCase(context).pauseSceneGeneration({
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation'
  })
  expect(writeExecution).toHaveBeenCalledTimes(1)
  const written = writeExecution.mock.calls[0]![0] as SceneGenerationExecution
  expect(written).toMatchObject({ pauseRequested: true, sequence: 2, state: 'running' })
  expect(requestPause).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: 'operation', pauseRequested: true })
  )
})
