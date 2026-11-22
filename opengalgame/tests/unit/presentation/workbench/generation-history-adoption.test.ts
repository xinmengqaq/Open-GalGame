import { describe, expect, it, vi } from 'vitest'

import type {
  SceneGenerationHistoryPageVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import { AppException } from '@common/errors/AppException'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '@presentation/feedback/workbenchFeedback'
import {
  failureViewOf,
  generationPhaseOf,
  isTerminalState,
  mergeRenderStatus,
  startBlockedReason,
  userMessageLabelOf
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'
import { generationRunViewOf } from '@presentation/pages/workbench/drawer/generation/generationRunView'
import {
  activeHistoryRowViewOf,
  unfinishedOperationRowViewOf
} from '@presentation/pages/workbench/drawer/generation/generationHistoryPresentation'
import { unfinishedSelectionOf } from '@presentation/pages/workbench/drawer/generation/useGenerationStatus'
import {
  prepareGenerationWorkspace,
  readGenerationHistory,
  WORKSPACE_NOT_READY_GENERATION_MESSAGE
} from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function historyPage(
  items: readonly SceneGenerationHistorySummaryVO[],
  unfinished: readonly SceneGenerationRenderStatusVO[] = []
): SceneGenerationHistoryPageVO {
  return { items, unfinished }
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

    expect(view?.runState).toBe('failed')
    expect(isTerminalState(failedHistory().state)).toBe(true)
    expect(
      startBlockedReason({
        saveState: 'saved',
        pageBlocked: false,
        canvasReady: true,
        statusCheck: 'ready',
        blockingOperation: null,
        unavailableReason: null
      })
    ).toBeNull()
  })

  it('历史非空仍合并无检查点未完成操作，不带终态过滤', async () => {
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
    const orphan = status({
      operationId: 'operation-orphan',
      state: 'running',
      stage: 'generating',
      updatedAt: '2026-10-30T12:00:00.000Z',
      canResumeUnfinished: true
    })
    const pendingVerification = status({
      operationId: 'operation-verification',
      state: 'interrupted',
      stage: 'failed',
      updatedAt: '2026-10-29T12:00:00.000Z',
      canVerifyResult: true,
      failure: {
        code: ErrorCodes.operationConflict,
        message: '提交结果待核对',
        reason: 'modelFailure',
        unverified: true
      }
    })
    const listHistory = vi.fn(async () =>
      ok(historyPage([summary], [orphan, pendingVerification]))
    )
    const readStatus = vi.fn(async () => ok(latest))
    const client = {
      listHistory,
      status: readStatus,
      latest: vi.fn()
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>

    const history = await readGenerationHistory(client, 'project-1', 'scene-1')

    expect(history).toEqual({
      kind: 'status',
      status: latest,
      unfinished: [orphan, pendingVerification]
    })
    expect(listHistory).toHaveBeenCalledWith({
      projectId: 'project-1',
      sceneId: 'scene-1',
      limit: 1,
      unfinishedLimit: 100
    })
    expect(readStatus).toHaveBeenCalledWith({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: latest.operationId
    })
  })

  it('只从发现列表选择遗留操作，不把列表外操作当成可选项', async () => {
    const orphan = status({
      operationId: 'operation-orphan',
      state: 'running',
      stage: 'generating',
      updatedAt: '2026-10-30T12:00:00.000Z',
      canResumeUnfinished: true
    })
    const pendingVerification = status({
      operationId: 'operation-verification',
      state: 'interrupted',
      stage: 'failed',
      canVerifyResult: true,
      failure: {
        code: ErrorCodes.operationConflict,
        message: '结果待核对',
        unverified: true
      }
    })
    const history = await readGenerationHistory(
      {
        listHistory: vi.fn(async () => ok(historyPage([], [orphan, pendingVerification]))),
        status: vi.fn(),
        latest: vi.fn(async () => ok(null))
      } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>,
      'project-1',
      'scene-1'
    )
    if (history.kind === 'error') throw new Error('历史读取失败')

    expect(history.unfinished.map((item) => item.operationId)).toEqual([
      'operation-orphan',
      'operation-verification'
    ])
    expect(
      unfinishedSelectionOf(history.unfinished, 'operation-verification', {
        projectId: 'project-1',
        sceneId: 'scene-1'
      })
    ).toBe(pendingVerification)
    expect(
      unfinishedSelectionOf(history.unfinished, 'operation-missing', {
        projectId: 'project-1',
        sceneId: 'scene-1'
      })
    ).toBeNull()
    expect(
      unfinishedSelectionOf(history.unfinished, 'operation-orphan', {
        projectId: 'project-2',
        sceneId: 'scene-1'
      })
    ).toBeNull()
    expect(unfinishedOperationRowViewOf(orphan)).toMatchObject({
      status: '生成中',
      canResume: true
    })
    expect(unfinishedOperationRowViewOf(pendingVerification)).toMatchObject({
      status: '结果待核对',
      canVerify: true
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
    const listHistory = vi.fn(async () => ok(historyPage([])))
    const readStatus = vi.fn()
    const readLatest = vi.fn(async () => ok(running))
    const client = {
      listHistory,
      status: readStatus,
      latest: readLatest
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>

    const history = await readGenerationHistory(client, 'project-1', 'scene-1')

    expect(history).toEqual({ kind: 'status', status: running, unfinished: [] })
    expect(listHistory).toHaveBeenCalledWith({
      projectId: 'project-1',
      sceneId: 'scene-1',
      limit: 1,
      unfinishedLimit: 100
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
    const listHistory = vi.fn(async () => ok(historyPage([])))
    const readStatus = vi.fn()
    const noExecution = {
      listHistory,
      status: readStatus,
      latest: vi.fn(async () => ok(null))
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
    await expect(readGenerationHistory(noExecution, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'empty',
      unfinished: []
    })

    const failedLatest = {
      listHistory,
      status: readStatus,
      latest: vi.fn(async () => ({ code: ErrorCodes.internalError, msg: '读取失败' }))
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
    await expect(readGenerationHistory(failedLatest, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'empty',
      unfinished: []
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

describe('生成历史读取错误与启动前工作区核对', () => {
  it('历史列表失败按错误返回，forbidden 单独保留', async () => {
    const failed = {
      listHistory: vi.fn(async () => ({
        code: ErrorCodes.communicationFailed,
        msg: '场景历史暂时读取失败，画布和作品都没有受影响。'
      })),
      status: vi.fn(),
      latest: vi.fn()
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
    await expect(readGenerationHistory(failed, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'error',
      message: '场景历史暂时读取失败，画布和作品都没有受影响。',
      forbidden: false
    })
    expect(failed.status).not.toHaveBeenCalled()

    const forbidden = {
      listHistory: vi.fn(async () => ({
        code: ErrorCodes.forbidden,
        msg: '当前环境不能读取生成历史'
      })),
      status: vi.fn(),
      latest: vi.fn()
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
    await expect(readGenerationHistory(forbidden, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'error',
      message: '当前环境不能读取生成历史',
      forbidden: true
    })
    expect(forbidden.latest).not.toHaveBeenCalled()
  })

  it('历史存在但状态读取失败时不伪造空态或最近执行', async () => {
    const summary: SceneGenerationHistorySummaryVO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1',
      boundary: 'failed',
      stage: 'failed',
      message: '生成已停止',
      createdAt: '2026-10-31T12:00:00.000Z'
    }
    const readLatest = vi.fn()
    const client = {
      listHistory: vi.fn(async () => ok(historyPage([summary]))),
      status: vi.fn(async () => ({ code: ErrorCodes.internalError, msg: '状态读取失败' })),
      latest: readLatest
    } as unknown as Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>

    await expect(readGenerationHistory(client, 'project-1', 'scene-1')).resolves.toEqual({
      kind: 'error',
      message: '状态读取失败',
      forbidden: false
    })
    expect(readLatest).not.toHaveBeenCalled()
  })

  it('启动前工作区核对成功、1309 与普通失败分别给确定结果', async () => {
    const successClient = {
      ensureProjectWorkspace: vi.fn(async () => ok({ projectId: 'project-1' }))
    } as unknown as ProjectClient
    await expect(prepareGenerationWorkspace(successClient, 'project-1')).resolves.toEqual({
      ok: true
    })

    const notReadyClient = {
      ensureProjectWorkspace: vi.fn(async () => {
        throw new AppException({
          code: PROJECT_WORKSPACE_NOT_READY_CODE,
          msg: '工程初始化未完成'
        })
      })
    } as unknown as ProjectClient
    await expect(prepareGenerationWorkspace(notReadyClient, 'project-1')).resolves.toEqual({
      ok: false,
      message: WORKSPACE_NOT_READY_GENERATION_MESSAGE,
      workspaceNotReady: true
    })

    const failedClient = {
      ensureProjectWorkspace: vi.fn(async () => {
        throw new AppException({ code: ErrorCodes.internalError, msg: '工程读取失败' })
      })
    } as unknown as ProjectClient
    await expect(prepareGenerationWorkspace(failedClient, 'project-1')).resolves.toEqual({
      ok: false,
      message: '工程读取失败',
      workspaceNotReady: false
    })
  })
})


describe('进度事件载荷过滤', () => {
  it('只把同一身份的新序号事件交给消费者，事件驱动状态投影可见更新', async () => {
    let emit: ((event: SceneGenerationRenderProgressEventVO) => void) | undefined
    const bridge = {
      onSceneGenerationProgress: (listener: (event: SceneGenerationRenderProgressEventVO) => void) => {
        emit = listener
        return () => {
          emit = undefined
        }
      },
      subscribeSceneGenerationProgress: vi.fn(async () => ok(null))
    } as unknown as DesktopBridge
    const client = new SceneGenerationClientImpl(bridge)
    const scope = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1'
    }
    const seen: number[] = []
    const stop = client.subscribeProgress(scope, (event) => seen.push(event.sequence))
    if (!emit) throw new Error('客户端没有注册进度监听')

    const event: SceneGenerationRenderProgressEventVO = {
      ...status({ state: 'running', stage: 'generating', sequence: 6 }),
      message: 'AI 正在生成候选脚本'
    }
    emit(event)
    emit({ ...event, projectId: 'project-2', sequence: 7 })
    emit({ ...event, sceneId: 'scene-2', sequence: 8 })
    emit({ ...event, operationId: 'operation-2', sequence: 9 })
    emit({ ...event, threadId: 'thread-2', sequence: 10 })
    emit({ ...event, branchId: 'branch-2', sequence: 11 })
    emit(event)
    expect(seen).toEqual([6])

    const validating: SceneGenerationRenderProgressEventVO = {
      ...event,
      sequence: 7,
      stage: 'validating',
      stageMessage: '正在校验候选脚本或按校验结果修正',
      message: '正在校验候选脚本或按校验结果修正'
    }
    emit(validating)
    expect(seen).toEqual([6, 7])
    expect(mergeRenderStatus(event, { ...event, sequence: 5 })).toBe(event)
    expect(mergeRenderStatus(event, validating)).toBe(validating)
    stop()
    expect(emit).toBeUndefined()
  })
})
