import { describe, expect, it, vi } from 'vitest'

import type { RetrySceneGenerationRepairDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'

const scope = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  operationId: 'operation-1',
  threadId: 'thread-1',
  branchId: 'branch-1'
}

function status(sequence = 1): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'running',
    stage: 'generating',
    stageMessage: 'AI 正在生成候选脚本',
    attempt: 1,
    sequence,
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'version-1',
      documentCount: 1,
      assetCount: 1,
      promptCount: 1,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, tokenLimit: 20 },
    previewAvailable: false
  }
}

function event(
  sequence: number,
  overrides: Partial<SceneGenerationRenderProgressEventVO> = {}
): SceneGenerationRenderProgressEventVO {
  const value = status(sequence)
  return { ...value, message: value.stageMessage, ...overrides }
}

type ProgressListener = (value: SceneGenerationRenderProgressEventVO) => void

interface BridgeFixture {
  bridge: DesktopBridge
  requests: unknown[]
  emit: (value: SceneGenerationRenderProgressEventVO) => void
  listenerCount: () => number
}

function bridgeWith(
  result: AjaxResult<null> = { code: ErrorCodes.success, msg: '已订阅', data: null }
): BridgeFixture {
  const listeners = new Set<ProgressListener>()
  const requests: unknown[] = []
  const bridge = {
    subscribeSceneGenerationProgress: vi.fn(async (request: unknown) => {
      requests.push(request)
      return result
    }),
    onSceneGenerationProgress: (listener: ProgressListener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  } as unknown as DesktopBridge
  return {
    bridge,
    requests,
    listenerCount: () => listeners.size,
    emit: (value) => {
      for (const listener of listeners) listener(value)
    }
  }
}

/** 让订阅请求的 then/catch 链跑完，不等待真实时间。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('SceneGenerationClientImpl.subscribeProgress', () => {
  it('发送完整订阅身份，并在请求完成前就接收匹配事件', async () => {
    const fixture = bridgeWith()
    const client = new SceneGenerationClientImpl(fixture.bridge)
    const seen: number[] = []

    const stop = client.subscribeProgress(scope, (value) => seen.push(value.sequence))
    fixture.emit(event(1))

    expect(seen).toEqual([1])
    await flushMicrotasks()
    expect(fixture.requests).toEqual([scope])
    stop()
  })

  it('按工程、场景、操作、线程和分支过滤事件，并按 sequence 去重', () => {
    const fixture = bridgeWith()
    const client = new SceneGenerationClientImpl(fixture.bridge)
    const seen: number[] = []

    const stop = client.subscribeProgress(scope, (value) => seen.push(value.sequence))
    fixture.emit(event(1))
    fixture.emit(event(1))
    fixture.emit(event(2, { projectId: 'project-2' }))
    fixture.emit(event(3, { sceneId: 'scene-2' }))
    fixture.emit(event(4, { operationId: 'operation-2' }))
    fixture.emit(event(5, { threadId: 'thread-2' }))
    fixture.emit(event(6, { branchId: 'branch-2' }))
    fixture.emit(event(7))

    expect(seen).toEqual([1, 7])
    stop()
  })

  it('退订同时移除渲染监听，之后的事件不再回调', () => {
    const fixture = bridgeWith()
    const client = new SceneGenerationClientImpl(fixture.bridge)
    const listener = vi.fn()

    const stop = client.subscribeProgress(scope, listener)
    expect(fixture.listenerCount()).toBe(1)
    stop()
    expect(fixture.listenerCount()).toBe(0)

    fixture.emit(event(1))
    expect(listener).not.toHaveBeenCalled()
  })

  it('订阅请求返回失败时用安全文案调用 onError', async () => {
    const fixture = bridgeWith({
      code: ErrorCodes.forbidden,
      msg: '当前环境不支持场景生成'
    })
    const client = new SceneGenerationClientImpl(fixture.bridge)
    const onError = vi.fn()

    const stop = client.subscribeProgress(scope, vi.fn(), onError)
    await flushMicrotasks()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('进度订阅未建立，正在用状态刷新。')
    stop()
  })

  it('订阅调用抛错或拒绝时也回调 onError', async () => {
    const throwing = {
      subscribeSceneGenerationProgress: () => {
        throw new Error('bridge missing')
      },
      onSceneGenerationProgress: () => () => undefined
    } as unknown as DesktopBridge
    const rejected = {
      subscribeSceneGenerationProgress: async () => {
        throw new Error('ipc closed')
      },
      onSceneGenerationProgress: () => () => undefined
    } as unknown as DesktopBridge
    const syncError = vi.fn()
    const asyncError = vi.fn()

    new SceneGenerationClientImpl(throwing).subscribeProgress(scope, vi.fn(), syncError)
    await flushMicrotasks()
    expect(syncError).toHaveBeenCalledTimes(1)

    new SceneGenerationClientImpl(rejected).subscribeProgress(scope, vi.fn(), asyncError)
    await flushMicrotasks()
    expect(asyncError).toHaveBeenCalledTimes(1)
  })

  it('退订后到达的失败结果不再回调 onError', async () => {
    const deferred = Promise.withResolvers<AjaxResult<null>>()
    const bridge = {
      subscribeSceneGenerationProgress: () => deferred.promise,
      onSceneGenerationProgress: () => () => undefined
    } as unknown as DesktopBridge
    const onError = vi.fn()
    const client = new SceneGenerationClientImpl(bridge)

    const stop = client.subscribeProgress(scope, vi.fn(), onError)
    stop()
    deferred.resolve({ code: ErrorCodes.forbidden, msg: '当前环境不支持场景生成' })
    await flushMicrotasks()

    expect(onError).not.toHaveBeenCalled()
  })
})

describe('SceneGenerationClientImpl.retryRepair', () => {
  function repair(): RetrySceneGenerationRepairDTO {
    return {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: 'thread-1',
        sourceBranchId: 'branch-1',
        sourceCheckpointId: 'checkpoint-1',
        candidateSnapshotId: 'candidate-1',
        instruction: '继续隐藏身份，把相认留到下一场'
      }
    }
  }

  it('原样发送来源身份、画布和确认正文，并解析安全状态', async () => {
    const retrySceneGenerationRepair = vi.fn(async () => ({
      code: ErrorCodes.success,
      msg: '修复重跑已启动',
      data: status(2)
    }))
    const client = new SceneGenerationClientImpl({
      retrySceneGenerationRepair
    } as unknown as DesktopBridge)
    const request = repair()

    await expect(client.retryRepair(request)).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '修复重跑已启动',
      data: { operationId: 'operation-1', state: 'running', sequence: 2 }
    })
    expect(retrySceneGenerationRepair).toHaveBeenCalledWith(request)
  })

  it('桥接抛错或返回不合格状态时收成通信失败，不伪造成功', async () => {
    const rejected = new SceneGenerationClientImpl({
      retrySceneGenerationRepair: async () => {
        throw new Error('ipc closed')
      }
    } as unknown as DesktopBridge)
    await expect(rejected.retryRepair(repair())).resolves.toMatchObject({
      code: ErrorCodes.communicationFailed
    })

    const malformed = new SceneGenerationClientImpl({
      retrySceneGenerationRepair: async () => ({
        code: ErrorCodes.success,
        msg: '修复重跑已启动',
        data: { operationId: 1 }
      })
    } as unknown as DesktopBridge)
    await expect(malformed.retryRepair(repair())).resolves.toMatchObject({
      code: ErrorCodes.communicationFailed
    })
  })
})
