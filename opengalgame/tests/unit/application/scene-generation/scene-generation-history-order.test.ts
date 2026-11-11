import { expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import { SceneGenerationHistoryQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationHistoryQueryServiceImpl'
import type { SceneGenerationStateVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const sameTime = '2026-10-21T09:00:00.000Z'
const olderTime = '2026-10-21T08:00:00.000Z'
const newestTime = '2026-10-22T01:00:00.000Z'

const stored: SceneGenerationExecution[] = [
  savedOperation('op-same-early', 'cp-same-early', 'succeeded', { updatedAt: sameTime }),
  savedOperation('op-old', 'cp-old', 'succeeded', { updatedAt: olderTime }),
  savedOperation('op-same-late', 'cp-same-late', 'succeeded', { updatedAt: sameTime }),
  savedOperation('op-no-checkpoint', undefined, 'succeeded', { updatedAt: newestTime }),
  savedOperation('op-no-boundary', 'cp-no-boundary', 'committing', { updatedAt: newestTime }),
  savedOperation('op-no-time', 'cp-no-time', 'succeeded', {}),
  savedOperation('op-new', 'cp-new', 'running', { timelineAt: newestTime })
]
const appendOrder = stored.map((execution) => execution.operationId)

it('场景历史按记录时间倒序向更早分页，同时间以后追加的操作优先', async () => {
  const service = new SceneGenerationHistoryQueryServiceImpl(unreadHistory, {
    listSceneExecutions: async () => stored
  })
  const scope = { projectId: 'project-1', sceneId: 'scene-1' }

  const first = await service.listSceneGenerationHistoryForScene({ ...scope, limit: 1 })
  expect(first.map((item) => item.checkpointId)).toEqual(['cp-new'])
  expect(first[0]?.createdAt).toBe(newestTime)

  const page = await service.listSceneGenerationHistoryForScene({ ...scope, limit: 2 })
  expect(page.map((item) => item.checkpointId)).toEqual(['cp-new', 'cp-same-late'])

  const next = await service.listSceneGenerationHistoryForScene({
    ...scope,
    limit: 2,
    cursor: page.at(-1)?.checkpointId
  })
  expect(next.map((item) => item.checkpointId)).toEqual(['cp-same-early', 'cp-old'])
  expect([...page, ...next].map((item) => item.operationId)).toEqual([
    'op-new',
    'op-same-late',
    'op-same-early',
    'op-old'
  ])

  await expect(
    service.listSceneGenerationHistoryForScene({ ...scope, limit: 2, cursor: 'missing-cursor' })
  ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })
  expect(stored.map((execution) => execution.operationId)).toEqual(appendOrder)
})

const unreadHistory: SceneGenerationHistoryReader = {
  listHistory: () => Promise.reject(new Error('场景历史分页不读取线程历史')),
  readCheckpoint: () => Promise.reject(new Error('场景历史分页不读取检查点详情'))
}

function savedOperation(
  operationId: string,
  checkpointId: string | undefined,
  state: SceneGenerationStateVO,
  time: { updatedAt?: string; timelineAt?: string }
): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId,
    threadId: `thread-${operationId}`,
    branchId: `branch-${operationId}`,
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/project',
      sceneDirectory: 'scenes/scene-1',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved-version',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 0 },
    reviewCandidate: false,
    baseline: { commitId: 'baseline', affectedFiles: [], lockState: 'unlocked' },
    state,
    step: state === 'running' ? ('generating' as const) : state === 'committing' ? ('committing' as const) : undefined,
    attempt: 1,
    sequence: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    ...(checkpointId ? { checkpointId } : {}),
    ...(time.updatedAt ? { updatedAt: time.updatedAt } : {}),
    ...(time.timelineAt
      ? {
          timeline: [
            {
              entryId: `${operationId}-entry`,
              sequence: 1,
              createdAt: time.timelineAt,
              kind: 'stage' as const,
              stage: 'generating' as const,
              message: '已记录'
            }
          ]
        }
      : {})
  }
}
