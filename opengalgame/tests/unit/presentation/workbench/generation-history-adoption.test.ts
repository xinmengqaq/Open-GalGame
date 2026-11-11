import { describe, expect, it, vi } from 'vitest'

import type {
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  failureViewOf,
  generationPhaseOf,
  isTerminalState,
  mergeRenderStatus,
  startBlockedReason,
  userMessageLabelOf
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'
import { generationRunViewOf } from '@presentation/pages/workbench/drawer/generation/generationRunView'
import { activeHistoryRowViewOf } from '@presentation/pages/workbench/drawer/generation/generationHistoryPresentation'
import { readGenerationHistory } from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'failed',
    stage: 'failed',
    stageMessage: '生成已停止',
    attempt: 0,
    sequence: 5,
    canPause: false,
    canResume: false,
    canCancel: false,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'v1',
      documentCount: 2,
      assetCount: 6,
      promptCount: 1,
      fieldBindingCount: 3,
      relationCount: 4,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 1200, outputTokens: 3400, totalTokens: 4600, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

function failedHistory(): SceneGenerationRenderStatusVO {
  return status({
    candidateSnapshotId: 'candidate-1',
    checkpointId: 'checkpoint-1',
    previewAuthorization: 'readOnly',
    previewAvailable: true,
    failure: {
      code: ErrorCodes.operationConflict,
      message: '模型调用失败，本次生成未完成',
      reason: 'modelFailure',
      reference: 'DIAG-27'
    },
    userMessages: [
      { kind: 'clarify', body: '先补充一句', round: 1 },
      { kind: 'revise', body: '把相认放到结尾', round: 2 }
    ]
  })
}

describe('生成历史投影', () => {
  it('重新挂载的历史失败状态走统一运行投影，并保留失败面板数据', () => {
    const latest = failedHistory()
    const view = generationRunViewOf(latest)

    expect(view).not.toBeNull()
    expect(view?.runState).toBe('failed')
    expect(view?.phase).toBe('failed')
    expect(view?.failureClass).toBe('modelTransient')
    expect(view?.nextActions).toEqual(['retryOperation', 'viewCandidate'])
    expect(failureViewOf(latest)).toEqual({
      title: '模型暂时不可用',
      message: '模型调用失败，本次生成未完成',
      reference: 'DIAG-27',
      recordedAt: null,
      unverified: false,
      retryHint: null
    })
    expect(view?.candidate.previous).toBe(true)
    expect(view?.candidate.previousNote).toBe('只能只读查看，不能接受或修改。')
    expect(latest.userMessages?.map(userMessageLabelOf)).toEqual([
      '第 1 轮补充说明',
      '第 2 轮修改要求'
    ])
  })

  it('历史里的取消和成功终态也只由权威状态判定', () => {
    const cancelled = status({ state: 'cancelled', stage: 'cancelled' })
    const succeeded = status({ state: 'succeeded', stage: 'completed', previewAvailable: true })

    expect(generationPhaseOf(cancelled)).toBe('cancelled')
    expect(generationPhaseOf(succeeded)).toBe('completed')
    expect(isTerminalState(cancelled.state)).toBe(true)
    expect(isTerminalState(succeeded.state)).toBe(true)
  })

  it('历史状态经统一序号合并不回退', () => {
    const current = failedHistory()

    expect(mergeRenderStatus(current, { ...current, sequence: 4 })).toBe(current)
    const newer = { ...current, sequence: 6, stageMessage: '仍未完成' }
    expect(mergeRenderStatus(current, newer)).toBe(newer)
  })

  it('历史状态按同一投影展示，不产生独立的采纳终态分支', () => {
    const running = status({
      operationId: 'operation-new',
      state: 'running',
      stage: 'generating',
      canPause: true,
      canCancel: true
    })

    expect(generationRunViewOf(running)?.phase).toBe('running')
    expect(isTerminalState(running.state)).toBe(false)
    expect(isTerminalState(failedHistory().state)).toBe(true)
  })

  it('历史失败终态投影后开始新操作不再被阻断', () => {
    const view = generationRunViewOf(failedHistory())
    const active = view !== null && !isTerminalState(view.runState)

    expect(
      startBlockedReason({
        saveState: 'saved',
        pageBlocked: false,
        canvasReady: true,
        active,
        unavailableReason: null
      })
    ).toBeNull()
  })

  it('历史读取返回最新失败状态，不带终态过滤', async () => {
    const latest = failedHistory()
    const summary: SceneGenerationHistorySummaryVO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: latest.operationId,
      threadId: latest.threadId,
      branchId: latest.branchId,
      checkpointId: 'checkpoint-1',
      boundary: 'failed',
      stage: 'failed',
      message: '生成已停止',
      createdAt: '2026-10-31T12:00:00.000Z'
    }
    const listHistory = vi.fn(async () => ok([summary]))
    const readStatus = vi.fn(async () => ok(latest))
    const client = {
      listHistory,
      status: readStatus,
      latest: vi.fn()
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>

    const history = await readGenerationHistory(client, 'project-1', 'scene-1')

    expect(history).toEqual({ kind: 'status', status: latest })
    expect(listHistory).toHaveBeenCalledWith({
      projectId: 'project-1',
      sceneId: 'scene-1',
      limit: 1
    })
    expect(readStatus).toHaveBeenCalledWith({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: latest.operationId
    })
  })

  it('历史为空时回退最近一次执行，运行中等待模型仍然可见可取消', async () => {
    const running = status({
      state: 'running',
      stage: 'generating',
      stageMessage: '等待模型响应（连接较慢时可继续等待或取消）',
      canPause: true,
      canCancel: true,
      activity: {
        kind: 'waitingModel',
        lastActivityAt: '2026-10-31T12:00:00.000Z'
      }
    })
    const listHistory = vi.fn(async () => ok([]))
    const readStatus = vi.fn()
    const readLatest = vi.fn(async () => ok(running))
    const client = {
      listHistory,
      status: readStatus,
      latest: readLatest
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>

    const history = await readGenerationHistory(client, 'project-1', 'scene-1')

    expect(history).toEqual({ kind: 'status', status: running })
    expect(listHistory).toHaveBeenCalledWith({
      projectId: 'project-1',
      sceneId: 'scene-1',
      limit: 1
    })
    expect(readLatest).toHaveBeenCalledWith({ projectId: 'project-1', sceneId: 'scene-1' })
    expect(readStatus).not.toHaveBeenCalled()
    expect(activeHistoryRowViewOf(running)).toEqual({
      status: '生成中',
      tone: 'live',
      message: '等待模型响应（连接较慢时可继续等待或取消）',
      canCancel: true
    })
  })

  it('历史为空且没有最近一次执行时保持空，不伪造历史条目', async () => {
    const listHistory = vi.fn(async () => ok([]))
    const readStatus = vi.fn()
    const noExecution = {
      listHistory,
      status: readStatus,
      latest: vi.fn(async () => ok(null))
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
    await expect(readGenerationHistory(noExecution, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'empty'
    })

    const failedLatest = {
      listHistory,
      status: readStatus,
      latest: vi.fn(async () => ({ code: ErrorCodes.internalError, msg: '读取失败' }))
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
    await expect(readGenerationHistory(failedLatest, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'empty'
    })
    expect(readStatus).not.toHaveBeenCalled()
  })

  it('进行中行只承载未结束操作，不把终态写成当前生成', () => {
    const running = status({ state: 'running', stage: 'generating', canCancel: true })
    expect(activeHistoryRowViewOf(running)).toMatchObject({ canCancel: true })

    expect(activeHistoryRowViewOf(status({ state: 'failed', stage: 'failed' }))).toBeNull()
    expect(activeHistoryRowViewOf(status({ state: 'cancelled', stage: 'cancelled' }))).toBeNull()
    expect(activeHistoryRowViewOf(status({ state: 'succeeded', stage: 'completed' }))).toBeNull()
    expect(activeHistoryRowViewOf(null)).toBeNull()
  })
})
