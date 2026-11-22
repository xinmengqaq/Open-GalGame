// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  SceneGenerationForkVO,
  SceneGenerationHistoryPageVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  START_ABORTED_NOTICE,
  START_SUPERSEDED_NOTICE,
  START_SWITCHED_FAILURE_PREFIX,
  START_SWITCHED_UNKNOWN_NOTICE,
  type ForkFromHistoryOutcome
} from '@presentation/pages/workbench/drawer/generation/useGenerationActions'
import {
  useSceneGeneration,
  type SceneGenerationController,
  type UseSceneGenerationOptions
} from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'
import {
  GENERATION_SELECTION_LOST_EMPTY_NOTICE,
  GENERATION_SELECTION_LOST_NOTICE
} from '@presentation/pages/workbench/drawer/generation/useGenerationStatus'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type SceneOptions = UseSceneGenerationOptions

const projectId = 'project-1'
const sceneId = 'scene-1'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function failed(code: number, msg: string, reason?: string): AjaxResult<never> {
  return { code, msg, ...(reason === undefined ? {} : { reason }) }
}

function missing(): AjaxResult<never> {
  return failed(
    ErrorCodes.invalidRequest,
    '该场景生成操作不存在',
    FailureReasons.sceneGenerationOperationMissing
  )
}

function statusOf(
  operationId: string,
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId,
    sceneId,
    operationId,
    threadId: `thread-${operationId}`,
    branchId: `branch-${operationId}`,
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
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

function summaryOf(operationId: string): SceneGenerationHistorySummaryVO {
  return {
    projectId,
    sceneId,
    operationId,
    threadId: `thread-${operationId}`,
    branchId: `branch-${operationId}`,
    checkpointId: `checkpoint-${operationId}`,
    boundary: 'failed',
    stage: 'failed',
    message: '生成已停止',
    createdAt: '2026-11-20T12:00:00.000Z'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  return Promise.withResolvers<T>()
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve()
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error('等待条件没有在限定轮次内成立')
}

interface MountedScene {
  readonly controller: () => SceneGenerationController
  update: (next: Partial<SceneOptions>) => Promise<void>
  unmount: () => Promise<void>
}

const mounted: MountedScene[] = []

async function mountSceneGeneration(options: SceneOptions): Promise<MountedScene> {
  let current: SceneGenerationController | null = null
  let props = options
  const Probe = (): null => {
    current = useSceneGeneration(props)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  await flush()
  const host: MountedScene = {
    controller: () => {
      if (current === null) throw new Error('场景生成 hook 尚未挂载')
      return current
    },
    update: async (next) => {
      props = { ...props, ...next }
      await act(async () => {
        root.render(createElement(Probe))
      })
      await flush()
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
  mounted.push(host)
  return host
}

afterEach(async () => {
  while (mounted.length > 0) {
    const host = mounted.pop()
    await host?.unmount()
  }
})

const projectClient = {
  ensureProjectWorkspace: vi.fn(async () => ok({} as never))
} as unknown as ProjectClient

function immediateSave(): Mock<() => Promise<{ ok: true }>> {
  return vi.fn(async () => ({ ok: true as const }))
}

interface ClientHooks {
  readonly listHistory: (request: {
    projectId: string
    sceneId: string
  }) => Promise<AjaxResult<SceneGenerationHistoryPageVO>>
  readonly status: (request: {
    projectId: string
    sceneId: string
    operationId: string
  }) => Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  readonly latest: (request: {
    projectId: string
    sceneId: string
  }) => Promise<AjaxResult<SceneGenerationRenderStatusVO | null>>
  readonly start: () => Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  readonly cancel: (request: {
    projectId: string
    sceneId: string
    operationId: string
  }) => Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  readonly fork: () => Promise<AjaxResult<SceneGenerationForkVO>>
  readonly subscribeProgress: SceneGenerationClient['subscribeProgress']
}

function fakeClient(hooks: Partial<ClientHooks>): SceneGenerationClient {
  return {
    listHistory: vi.fn(hooks.listHistory ?? (async () => ok({ items: [], unfinished: [] }))),
    status: vi.fn(
      hooks.status ?? (async () => failed(ErrorCodes.communicationFailed, '测试没有配置状态读取'))
    ),
    latest: vi.fn(hooks.latest ?? (async () => ok(null))),
    start: vi.fn(hooks.start ?? (async () => failed(ErrorCodes.internalError, '测试没有配置启动'))),
    cancel: vi.fn(
      hooks.cancel ?? (async () => failed(ErrorCodes.internalError, '测试没有配置取消'))
    ),
    fork: vi.fn(hooks.fork ?? (async () => failed(ErrorCodes.internalError, '测试没有配置分叉'))),
    subscribeProgress: vi.fn(hooks.subscribeProgress ?? (() => () => undefined))
  } as unknown as SceneGenerationClient
}

function sceneOptions(
  client: SceneGenerationClient,
  saveCanvas = immediateSave(),
  overrides: Partial<SceneOptions> = {}
): SceneOptions {
  return {
    projectClient,
    client,
    projectId,
    sceneId,
    canvasId: 'canvas-1',
    saveState: 'saved' as WorkbenchSaveState,
    pageBlocked: false,
    canvasReady: true,
    saveCanvas,
    ...overrides
  }
}

describe('开始生成与首次状态读取的顺序', () => {
  it('首次状态未核实时按钮与动作共用同一个禁止原因，且不发送保存或启动', async () => {
    const history = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const saveCanvas = immediateSave()
    const startSpy = vi.fn(() => started.promise)
    const client = fakeClient({
      listHistory: () => history.promise,
      latest: async () => ok(null),
      start: startSpy
    })
    const host = await mountSceneGeneration(sceneOptions(client, saveCanvas))

    expect(host.controller().status).toBeNull()
    expect(host.controller().startBlockedReason).toContain('正在核对当前场景是否已有任务')

    let blockedStart!: Promise<void>
    await act(async () => {
      blockedStart = host.controller().start()
    })
    await blockedStart
    await flush()

    expect(saveCanvas).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()
    expect(host.controller().actionError?.kind).toBe('start')
    expect(host.controller().actionError?.message).toContain('正在核对')

    history.resolve(ok({ items: [], unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().startBlockedReason === null)

    let allowedStart!: Promise<void>
    await act(async () => {
      allowedStart = host.controller().start()
    })
    await waitFor(() => startSpy.mock.calls.length === 1)
    started.resolve(ok(statusOf('operation-new', { state: 'running', stage: 'generating' })))
    await act(async () => {
      await allowedStart
    })
    await flush()

    expect(saveCanvas).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-new')
  })

  it('读回在 saveCanvas 之前落地时启动继续，只发一次 start，新操作可见并可订阅进度', async () => {
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-a')]
    const readbackHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const saveCanvas = deferred<{ ok: true }>()
    const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const startSpy = vi.fn(() => started.promise)
    let reloadCalls = 0
    const client = fakeClient({
      listHistory: async () => {
        reloadCalls += 1
        return reloadCalls === 1 ? ok({ items, unfinished: [] }) : readbackHistory.promise
      },
      status: async (request) => ok(statusOf(request.operationId)),
      start: startSpy
    })
    const saveSpy = vi.fn(() => saveCanvas.promise)
    const host = await mountSceneGeneration(sceneOptions(client, saveSpy))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    expect(host.controller().startBlockedReason).toBeNull()

    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => saveSpy.mock.calls.length === 1)

    items = [summaryOf('operation-readback')]
    await act(async () => {
      host.controller().reload()
    })
    readbackHistory.resolve(ok({ items, unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().status?.operationId === 'operation-readback')

    saveCanvas.resolve({ ok: true })
    await flush()
    await waitFor(() => startSpy.mock.calls.length === 1)

    started.resolve(ok(statusOf('operation-b', { state: 'running', stage: 'generating' })))
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-b')
    expect(host.controller().startNotice).toBeNull()
    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-b')
  })

  it('读回发现已有活动任务时不再发出 start，并显示同一禁止原因', async () => {
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-a')]
    const readbackHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const saveCanvas = deferred<{ ok: true }>()
    const startSpy = vi.fn(async () => ok(statusOf('operation-b')))
    let listCalls = 0
    const client = fakeClient({
      listHistory: async () => {
        listCalls += 1
        return listCalls === 1 ? ok({ items, unfinished: [] }) : readbackHistory.promise
      },
      status: async (request) =>
        ok(
          request.operationId === 'operation-live'
            ? statusOf('operation-live', {
                state: 'running',
                stage: 'generating',
                mode: 'generate',
                blocksNewGeneration: true
              })
            : statusOf(request.operationId)
        ),
      start: startSpy
    })
    const saveSpy = vi.fn(() => saveCanvas.promise)
    const host = await mountSceneGeneration(sceneOptions(client, saveSpy))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => saveSpy.mock.calls.length === 1)

    items = [summaryOf('operation-live')]
    await act(async () => {
      host.controller().reload()
    })
    readbackHistory.resolve(ok({ items, unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().status?.operationId === 'operation-live')

    saveCanvas.resolve({ ok: true })
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).not.toHaveBeenCalled()
    expect(host.controller().status?.operationId).toBe('operation-live')
    expect(host.controller().actionError?.kind).toBe('start')
    expect(host.controller().actionError?.message).toContain('当前场景已有进行中的生成')
    expect(host.controller().actionError?.message).toContain('先完成或结束它')
  })

  it('读回在 client.start 之后落地时，启动结果不静默消失，新操作可见', async () => {
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-a')]
    const readbackHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const startSpy = vi.fn(() => started.promise)
    let listCalls = 0
    const client = fakeClient({
      listHistory: async () => {
        listCalls += 1
        return listCalls === 1 ? ok({ items, unfinished: [] }) : readbackHistory.promise
      },
      status: async (request) => ok(statusOf(request.operationId)),
      start: startSpy
    })
    const host = await mountSceneGeneration(sceneOptions(client))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')

    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => startSpy.mock.calls.length === 1)

    items = [summaryOf('operation-readback')]
    await act(async () => {
      host.controller().reload()
    })
    readbackHistory.resolve(ok({ items, unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().status?.operationId === 'operation-readback')

    started.resolve(ok(statusOf('operation-b', { state: 'running', stage: 'generating' })))
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-b')
    expect(host.controller().startNotice).toBeNull()
    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-b')
  })

  it('读回把视图切到旧操作后再次点击不会多发一次 start', async () => {
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-a')]
    const readbackHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const saveCanvas = deferred<{ ok: true }>()
    const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const startSpy = vi.fn(() => started.promise)
    let listCalls = 0
    const client = fakeClient({
      listHistory: async () => {
        listCalls += 1
        return listCalls === 1 ? ok({ items, unfinished: [] }) : readbackHistory.promise
      },
      status: async (request) => ok(statusOf(request.operationId)),
      start: startSpy
    })
    const saveSpy = vi.fn(() => saveCanvas.promise)
    const host = await mountSceneGeneration(sceneOptions(client, saveSpy))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => saveSpy.mock.calls.length === 1)

    items = [summaryOf('operation-readback')]
    await act(async () => {
      host.controller().reload()
    })
    readbackHistory.resolve(ok({ items, unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().status?.operationId === 'operation-readback')

    await act(async () => {
      await host.controller().start()
    })
    await flush()
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(0)

    saveCanvas.resolve({ ok: true })
    await flush()
    await waitFor(() => startSpy.mock.calls.length === 1)
    started.resolve(ok(statusOf('operation-b', { state: 'running', stage: 'generating' })))
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-b')
  })

  it('启动失败在被动读回之后仍显示，不静默丢弃', async () => {
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-a')]
    const readbackHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const startSpy = vi.fn(() => started.promise)
    let listCalls = 0
    const client = fakeClient({
      listHistory: async () => {
        listCalls += 1
        return listCalls === 1 ? ok({ items, unfinished: [] }) : readbackHistory.promise
      },
      status: async (request) => ok(statusOf(request.operationId)),
      start: startSpy
    })
    const host = await mountSceneGeneration(sceneOptions(client))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => startSpy.mock.calls.length === 1)

    items = [summaryOf('operation-readback')]
    await act(async () => {
      host.controller().reload()
    })
    readbackHistory.resolve(ok({ items, unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().status?.operationId === 'operation-readback')

    started.resolve(
      failed(ErrorCodes.operationConflict, '该创作对话仍有未结束操作，请先回复、恢复或取消')
    )
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-readback')
    expect(host.controller().actionError?.kind).toBe('start')
    expect(host.controller().actionError?.message).toContain('仍有未结束操作')
    expect(host.controller().startNotice).toBe(
      `${START_SWITCHED_FAILURE_PREFIX}该创作对话仍有未结束操作，请先回复、恢复或取消`
    )
  })

  it('saveCanvas 抛错在被动读回之后仍显示为启动失败，不静默消失', async () => {
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-a')]
    const readbackHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const saveCanvas = deferred<{ ok: true }>()
    const startSpy = vi.fn(async () => ok(statusOf('operation-b')))
    let listCalls = 0
    const client = fakeClient({
      listHistory: async () => {
        listCalls += 1
        return listCalls === 1 ? ok({ items, unfinished: [] }) : readbackHistory.promise
      },
      status: async (request) => ok(statusOf(request.operationId)),
      start: startSpy
    })
    const saveSpy = vi.fn(() => saveCanvas.promise)
    const host = await mountSceneGeneration(sceneOptions(client, saveSpy))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => saveSpy.mock.calls.length === 1)

    items = [summaryOf('operation-readback')]
    await act(async () => {
      host.controller().reload()
    })
    readbackHistory.resolve(ok({ items, unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().status?.operationId === 'operation-readback')

    saveCanvas.reject(new AppException({ code: ErrorCodes.internalError, msg: '画布保存通道异常' }))
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).not.toHaveBeenCalled()
    expect(host.controller().status?.operationId).toBe('operation-readback')
    expect(host.controller().actionError?.kind).toBe('start')
    expect(host.controller().actionError?.message).toBe('画布保存通道异常')
    expect(host.controller().startNotice).toBe(
      `${START_SWITCHED_FAILURE_PREFIX}画布保存通道异常`
    )
  })

  it('作者显式换任务后不强制跳回，启动结果以固定提示保留原动作归属', async () => {
    const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const startSpy = vi.fn(() => started.promise)
    const client = fakeClient({
      listHistory: async () =>
        ok({
          items: [summaryOf('operation-a')],
          unfinished: [statusOf('operation-u', { state: 'running', stage: 'generating' })]
        }),
      status: async (request) =>
        ok(
          request.operationId === 'operation-u'
            ? statusOf('operation-u', { state: 'running', stage: 'generating' })
            : statusOf(request.operationId)
        ),
      start: startSpy
    })
    const host = await mountSceneGeneration(sceneOptions(client))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => startSpy.mock.calls.length === 1)

    await act(async () => {
      expect(host.controller().selectUnfinished('operation-u')).toBe(true)
    })
    expect(host.controller().status?.operationId).toBe('operation-u')

    started.resolve(ok(statusOf('operation-b', { state: 'running', stage: 'generating' })))
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-u')
    expect(host.controller().startNotice).toBe(START_SUPERSEDED_NOTICE)
    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-b')).toBe(false)
  })

  it('切场景的首帧先阻断启动；已派发的启动在切场景后不再发出，并留下归属提示', async () => {
    const sceneTwoHistory = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
    const saveCanvas = deferred<{ ok: true }>()
    const startSpy = vi.fn(async () => ok(statusOf('operation-b')))
    const client = fakeClient({
      listHistory: async (request) =>
        request.sceneId === sceneId
          ? ok({ items: [summaryOf('operation-a')], unfinished: [] })
          : sceneTwoHistory.promise,
      status: async (request) => ok(statusOf(request.operationId)),
      latest: async () => ok(null),
      start: startSpy
    })
    const saveSpy = vi.fn(() => saveCanvas.promise)
    const host = await mountSceneGeneration(sceneOptions(client, saveSpy))

    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = host.controller().start()
    })
    await waitFor(() => saveSpy.mock.calls.length === 1)

    await host.update({ sceneId: 'scene-2' })
    expect(host.controller().status).toBeNull()
    expect(host.controller().startBlockedReason).toContain('正在核对当前场景是否已有任务')

    await act(async () => {
      await host.controller().start()
    })
    expect(saveSpy).toHaveBeenCalledTimes(1)

    saveCanvas.resolve({ ok: true })
    await flush()
    await act(async () => {
      await startPromise
    })
    await flush()

    expect(startSpy).not.toHaveBeenCalled()
    expect(host.controller().startNotice).toBe(START_ABORTED_NOTICE)
    expect(host.controller().status).toBeNull()

    sceneTwoHistory.resolve(ok({ items: [], unfinished: [] }))
    await flush()
    await waitFor(() => host.controller().startBlockedReason === null)
  })
})

describe('选中记录的状态读取事实', () => {
  it('操作存在但检查点读取失败时保留显式选择与当前视图，只显示目标读取错误', async () => {
    let pinnedStatus: AjaxResult<SceneGenerationRenderStatusVO> = ok(
      statusOf('operation-u', { state: 'running', stage: 'generating' })
    )
    const client = fakeClient({
      listHistory: async () =>
        ok({
          items: [summaryOf('operation-source')],
          unfinished: [statusOf('operation-u', { state: 'running', stage: 'generating' })]
        }),
      status: async (request) =>
        request.operationId === 'operation-u' ? pinnedStatus : ok(statusOf('operation-source')),
      latest: async () => ok(null)
    })
    const host = await mountSceneGeneration(sceneOptions(client))

    await waitFor(() => host.controller().status?.operationId === 'operation-source')
    await act(async () => {
      expect(host.controller().selectUnfinished('operation-u')).toBe(true)
    })

    pinnedStatus = failed(ErrorCodes.invalidRequest, '历史检查点不存在')
    await act(async () => {
      host.controller().reload()
    })
    await flush()

    expect(host.controller().status?.operationId).toBe('operation-u')
    expect(host.controller().selectionNotice).toBeNull()
    expect(host.controller().loadError).toBe('历史检查点不存在')
    const statusCalls = vi.mocked(client.status).mock.calls
    expect(statusCalls.at(-1)?.[0].operationId).toBe('operation-u')

    await act(async () => {
      host.controller().reload()
    })
    await flush()
    expect(vi.mocked(client.status).mock.calls.at(-1)?.[0].operationId).toBe('operation-u')
  })

  it('只有结构化“操作不存在”才清选择；回退记录与回退为空分别提示', async () => {
    let pinnedStatus: AjaxResult<SceneGenerationRenderStatusVO> = ok(
      statusOf('operation-u', { state: 'running', stage: 'generating' })
    )
    let items: SceneGenerationHistorySummaryVO[] = [summaryOf('operation-source')]
    let unfinishedItems: SceneGenerationRenderStatusVO[] = [
      statusOf('operation-u', { state: 'running', stage: 'generating' })
    ]
    let latestStatus: SceneGenerationRenderStatusVO | null = null
    const client = fakeClient({
      listHistory: async () => ok({ items, unfinished: unfinishedItems }),
      status: async (request) =>
        request.operationId === 'operation-u' ? pinnedStatus : ok(statusOf(request.operationId)),
      latest: async () => ok(latestStatus)
    })
    const host = await mountSceneGeneration(sceneOptions(client))

    await waitFor(() => host.controller().status?.operationId === 'operation-source')
    await act(async () => {
      expect(host.controller().selectUnfinished('operation-u')).toBe(true)
    })

    pinnedStatus = missing()
    await act(async () => {
      host.controller().reload()
    })
    await flush()

    expect(host.controller().status?.operationId).toBe('operation-source')
    expect(host.controller().selectionNotice).toBe(GENERATION_SELECTION_LOST_NOTICE)

    await act(async () => {
      expect(host.controller().selectUnfinished('operation-u')).toBe(true)
    })
    items = []
    unfinishedItems = []
    latestStatus = null
    await act(async () => {
      host.controller().reload()
    })
    await flush()

    expect(host.controller().status).toBeNull()
    expect(host.controller().selectionNotice).toBe(GENERATION_SELECTION_LOST_EMPTY_NOTICE)
  })
})

const forkSource = {
  projectId,
  sceneId,
  threadId: 'thread-source',
  branchId: 'branch-source',
  checkpointId: 'checkpoint-source'
}

function forkStatus(operationId: string): SceneGenerationForkVO {
  return {
    status: statusOf(operationId, { state: 'running', stage: 'generating' }),
    source: { summary: '来源记录' }
  }
}

interface ForkThenStartResult {
  readonly host: MountedScene
  readonly client: SceneGenerationClient
  readonly startSpy: Mock<() => Promise<AjaxResult<SceneGenerationRenderStatusVO>>>
  readonly forkSpy: Mock<() => Promise<AjaxResult<SceneGenerationForkVO>>>
}

/**
 * 分叉与启动并发，分叉先成功并切到新操作；随后才结算启动。
 * 三次测试共用同一真实 hook 宿主，只改启动的最终响应。
 */
async function forkThenFinishStart(
  startOutcome: AjaxResult<SceneGenerationRenderStatusVO>,
  forkOutcome: AjaxResult<SceneGenerationForkVO> = ok(forkStatus('operation-fork'))
): Promise<ForkThenStartResult> {
  const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
  const forked = deferred<AjaxResult<SceneGenerationForkVO>>()
  const startSpy = vi.fn(() => started.promise)
  const forkSpy = vi.fn(() => forked.promise)
  const client = fakeClient({
    listHistory: async () => ok({ items: [summaryOf('operation-a')], unfinished: [] }),
    status: async (request) =>
      ok(
        request.operationId === 'operation-fork'
          ? statusOf('operation-fork', { state: 'running', stage: 'generating' })
          : statusOf(request.operationId)
      ),
    start: startSpy,
    fork: forkSpy
  })
  const host = await mountSceneGeneration(sceneOptions(client))
  await waitFor(() => host.controller().status?.operationId === 'operation-a')

  let startPromise!: Promise<void>
  let forkPromise!: Promise<ForkFromHistoryOutcome>
  await act(async () => {
    startPromise = host.controller().start()
    forkPromise = host.controller().forkFromHistory(forkSource)
  })
  await waitFor(
    () => startSpy.mock.calls.length === 1 && forkSpy.mock.calls.length === 1
  )

  await act(async () => {
    forked.resolve(forkOutcome)
    await forkPromise
  })
  await flush()
  if (forkOutcome.code === ErrorCodes.success) {
    expect(host.controller().status?.operationId).toBe('operation-fork')
  }

  await act(async () => {
    started.resolve(startOutcome)
    await startPromise
  })
  await flush()
  return { host, client, startSpy, forkSpy }
}

describe('分叉先成功后迟到的启动结果', () => {
  it('启动成功不抢回分叉视图，只留下固定提示且不把进度订阅切走', async () => {
    const { host, client, startSpy, forkSpy } = await forkThenFinishStart(
      ok(statusOf('operation-b', { state: 'running', stage: 'generating' }))
    )

    expect(host.controller().status?.operationId).toBe('operation-fork')
    expect(host.controller().startNotice).toBe(START_SUPERSEDED_NOTICE)
    expect(host.controller().actionError).toBeNull()
    expect(host.controller().pending).toBeNull()
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(forkSpy).toHaveBeenCalledTimes(1)

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-b')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-fork')
  })

  it('启动确认失败不贴到分叉视图，提示仍归属原启动动作', async () => {
    const conflict = failed(
      ErrorCodes.operationConflict,
      '该创作对话仍有未结束操作，请先回复、恢复或取消'
    )
    const { host, client, startSpy, forkSpy } = await forkThenFinishStart(conflict)

    expect(host.controller().status?.operationId).toBe('operation-fork')
    expect(host.controller().actionError).toBeNull()
    expect(host.controller().startNotice).toBe(
      `${START_SWITCHED_FAILURE_PREFIX}${conflict.msg}`
    )
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(forkSpy).toHaveBeenCalledTimes(1)

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-b')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-fork')
  })

  it('通信失败如实说结果待确认，不冒充确认失败也不引导直接重试', async () => {
    const unknown = failed(
      ErrorCodes.communicationFailed,
      '与主进程通信失败，操作结果待确认'
    )
    const { host, client, startSpy } = await forkThenFinishStart(unknown)

    expect(host.controller().status?.operationId).toBe('operation-fork')
    expect(host.controller().actionError).toBeNull()
    expect(host.controller().startNotice).toBe(START_SWITCHED_UNKNOWN_NOTICE)
    expect(host.controller().startNotice).toContain('待确认')
    expect(host.controller().startNotice).not.toContain('没有成功')
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().pending).toBeNull()

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-b')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-fork')
  })

  it('分叉确认失败不算成功切换，随后启动成功仍采纳新操作', async () => {
    const { host, client, startSpy } = await forkThenFinishStart(
      ok(statusOf('operation-b', { state: 'running', stage: 'generating' })),
      failed(ErrorCodes.operationConflict, '来源记录不可分叉')
    )

    expect(host.controller().status?.operationId).toBe('operation-b')
    expect(host.controller().startNotice).toBeNull()
    expect(host.controller().actionError).toBeNull()
    expect(startSpy).toHaveBeenCalledTimes(1)

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-fork')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-b')
  })
})

interface StartThenForkResult {
  readonly host: MountedScene
  readonly client: SceneGenerationClient
  readonly startSpy: Mock<() => Promise<AjaxResult<SceneGenerationRenderStatusVO>>>
  readonly forkSpy: Mock<() => Promise<AjaxResult<SceneGenerationForkVO>>>
  readonly forkOutcome: ForkFromHistoryOutcome
}

/**
 * 启动与分叉并发，启动先结算；随后分叉成功返回。
 * 与 fork-first 共用同一个真实宿主和假客户端，只调换两个 deferred 的结算顺序。
 */
async function startThenFinishFork(
  startOutcome: AjaxResult<SceneGenerationRenderStatusVO>
): Promise<StartThenForkResult> {
  const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
  const forked = deferred<AjaxResult<SceneGenerationForkVO>>()
  const startSpy = vi.fn(() => started.promise)
  const forkSpy = vi.fn(() => forked.promise)
  const client = fakeClient({
    listHistory: async () => ok({ items: [summaryOf('operation-a')], unfinished: [] }),
    status: async (request) =>
      ok(
        request.operationId === 'operation-fork'
          ? statusOf('operation-fork', { state: 'running', stage: 'generating' })
          : statusOf(request.operationId)
      ),
    start: startSpy,
    fork: forkSpy
  })
  const host = await mountSceneGeneration(sceneOptions(client))
  await waitFor(() => host.controller().status?.operationId === 'operation-a')

  let startPromise!: Promise<void>
  let forkPromise!: Promise<ForkFromHistoryOutcome>
  await act(async () => {
    startPromise = host.controller().start()
    forkPromise = host.controller().forkFromHistory(forkSource)
  })
  await waitFor(
    () => startSpy.mock.calls.length === 1 && forkSpy.mock.calls.length === 1
  )

  await act(async () => {
    started.resolve(startOutcome)
    await startPromise
  })
  await flush()

  let forkOutcome!: ForkFromHistoryOutcome
  await act(async () => {
    forked.resolve(ok(forkStatus('operation-fork')))
    forkOutcome = await forkPromise
  })
  await flush()
  return { host, client, startSpy, forkSpy, forkOutcome }
}

describe('启动先结算后分叉返回', () => {
  it('启动成功先切到新操作，随后分叉结果明确告知未切换且仍可找回', async () => {
    const { host, client, startSpy, forkSpy, forkOutcome } = await startThenFinishFork(
      ok(statusOf('operation-b', { state: 'running', stage: 'generating' }))
    )

    expect(host.controller().status?.operationId).toBe('operation-b')
    expect(host.controller().startNotice).toBeNull()
    expect(host.controller().actionError).toBeNull()
    expect(forkOutcome).toMatchObject({
      kind: 'forked',
      viewSwitched: false,
      fork: { status: { operationId: 'operation-fork' } }
    })
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(forkSpy).toHaveBeenCalledTimes(1)

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-fork')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-b')
  })

  it('启动确认失败先落地，随后分叉成功也不抹掉启动失败提示', async () => {
    const conflict = failed(
      ErrorCodes.operationConflict,
      '该创作对话仍有未结束操作，请先回复、恢复或取消'
    )
    const { host, client, startSpy, forkSpy, forkOutcome } = await startThenFinishFork(conflict)

    expect(host.controller().status?.operationId).toBe('operation-fork')
    expect(host.controller().actionError).toBeNull()
    expect(host.controller().startNotice).toBe(
      `${START_SWITCHED_FAILURE_PREFIX}${conflict.msg}`
    )
    expect(forkOutcome).toMatchObject({ kind: 'forked' })
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(forkSpy).toHaveBeenCalledTimes(1)

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-b')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-fork')
  })

  it('启动丢回执先落地，分叉成功后仍保留待确认提示且不误报失败', async () => {
    const unknown = failed(ErrorCodes.communicationFailed, '与主进程通信失败，操作结果待确认')
    const { host, client, startSpy, forkSpy } = await startThenFinishFork(unknown)

    expect(host.controller().status?.operationId).toBe('operation-fork')
    expect(host.controller().actionError).toBeNull()
    expect(host.controller().startNotice).toBe(START_SWITCHED_UNKNOWN_NOTICE)
    expect(host.controller().startNotice).toContain('待确认')
    expect(host.controller().startNotice).not.toContain('没有成功')
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(forkSpy).toHaveBeenCalledTimes(1)

    const subscriptions = vi.mocked(client.subscribeProgress).mock.calls
    expect(subscriptions.some(([scope]) => scope.operationId === 'operation-b')).toBe(false)
    expect(subscriptions.at(-1)?.[0].operationId).toBe('operation-fork')
  })
})

describe('历史中已有生成对普通启动的门禁', () => {
  const pendingGenerate = statusOf('operation-pending', {
    state: 'pending',
    stage: 'readingInput',
    stageMessage: '正在读取已保存编排与输入',
    blocksNewGeneration: true
  })
  const terminalSelected = statusOf('operation-done', {
    state: 'succeeded',
    stage: 'completed',
    canPause: false,
    canCancel: false,
    result: { commitId: 'commit-done' }
  })

  function selectedTerminalClient(
    unfinished: () => readonly SceneGenerationRenderStatusVO[],
    start: () => Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  ): SceneGenerationClient {
    return fakeClient({
      listHistory: async () =>
        ok({ items: [summaryOf('operation-done')], unfinished: unfinished() }),
      status: async (request) => ok(statusOf(request.operationId)),
      start
    })
  }

  it('选中的是终态时，历史中非终态 generate 仍给出真实原因并拒绝发保存与启动', async () => {
    const startSpy = vi.fn(async () =>
      ok(statusOf('operation-new', { state: 'running', stage: 'generating' }))
    )
    const saveCanvas = immediateSave()
    const client = fakeClient({
      listHistory: async () =>
        ok({ items: [summaryOf('operation-done')], unfinished: [pendingGenerate] }),
      status: async (request) =>
        ok(
          request.operationId === 'operation-done'
            ? terminalSelected
            : statusOf(request.operationId)
        ),
      start: startSpy
    })
    const host = await mountSceneGeneration(sceneOptions(client, saveCanvas))

    await waitFor(() => host.controller().status?.operationId === 'operation-done')
    expect(host.controller().startBlockedByGeneration).toBe(true)
    expect(host.controller().startBlockedReason).toContain('当前场景已有进行中的生成')
    expect(host.controller().startBlockedReason).toContain('正在读取已保存编排与输入')
    expect(host.controller().startBlockedReason).toContain('AI 历史')
    // 冲突只挡普通启动，不挡合法修复。
    expect(host.controller().repairBlockedReason).toBeNull()

    await act(async () => {
      await host.controller().start()
    })
    await flush()

    expect(saveCanvas).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()
    expect(host.controller().actionError).toEqual(
      expect.objectContaining({
        kind: 'start',
        message: host.controller().startBlockedReason
      })
    )
  })

  it('未完成列表只有 repair 或缺少 mode 的分叉记录时不阻断合法启动', async () => {
    const pendingRepair = statusOf('operation-repair', {
      state: 'running',
      mode: 'repair',
      stage: 'generating'
    })
    const pendingFork = statusOf('operation-fork', {
      state: 'pending',
      mode: undefined,
      stage: 'readingInput'
    })
    const startSpy = vi.fn(async () =>
      ok(statusOf('operation-new', { state: 'running', stage: 'generating' }))
    )
    const saveCanvas = immediateSave()
    const client = selectedTerminalClient(() => [pendingRepair, pendingFork], startSpy)
    const host = await mountSceneGeneration(sceneOptions(client, saveCanvas))

    await waitFor(() => host.controller().status?.operationId === 'operation-done')
    expect(host.controller().startBlockedReason).toBeNull()
    expect(host.controller().startBlockedByGeneration).toBe(false)

    await act(async () => {
      await host.controller().start()
    })
    await flush()

    expect(saveCanvas).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  it('未完成列表刷新为不再阻断后，原禁止原因解除且启动恢复可用', async () => {
    let unfinished: readonly SceneGenerationRenderStatusVO[] = [pendingGenerate]
    const startSpy = vi.fn(async () =>
      ok(statusOf('operation-new', { state: 'running', stage: 'generating' }))
    )
    const saveCanvas = immediateSave()
    const client = selectedTerminalClient(() => unfinished, startSpy)
    const host = await mountSceneGeneration(sceneOptions(client, saveCanvas))

    await waitFor(() => host.controller().status?.operationId === 'operation-done')
    expect(host.controller().startBlockedReason).toContain('当前场景已有进行中的生成')

    unfinished = []
    await act(async () => {
      host.controller().reload()
    })
    await waitFor(() => host.controller().startBlockedReason === null)
    expect(host.controller().startBlockedByGeneration).toBe(false)

    await act(async () => {
      await host.controller().start()
    })
    await flush()

    expect(saveCanvas).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)
  })
})

describe('权威终态让旧发现项失效', () => {
  const blockingA = statusOf('operation-a', {
    state: 'waiting',
    stage: 'waitingReview',
    stageMessage: '候选已就绪，等待你的决定',
    checkpointId: 'checkpoint-a',
    mode: 'generate',
    blocksNewGeneration: true,
    canCancel: true
  })
  const terminalB = statusOf('operation-b', {
    state: 'succeeded',
    stage: 'completed',
    canPause: false,
    canCancel: false,
    result: { commitId: 'commit-b' }
  })

  it('取消 blocking A 后旧发现项不复活；C 终态不误挡且新 D 仍可发现', async () => {
    let unfinishedItems: SceneGenerationRenderStatusVO[] = [blockingA]
    let progressListener: ((event: SceneGenerationRenderProgressEventVO) => void) | null = null
    let statusC = statusOf('operation-c', {
      state: 'running',
      stage: 'generating',
      mode: 'generate',
      blocksNewGeneration: true
    })
    const startSpy = vi.fn(async () => ok(statusC))
    const cancelSpy = vi.fn(async () =>
      ok(
        statusOf('operation-a', {
          state: 'cancelled',
          stage: 'cancelled',
          checkpointId: 'checkpoint-a',
          mode: 'generate',
          sequence: 20,
          canPause: false,
          canCancel: false
        })
      )
    )
    const client = fakeClient({
      listHistory: async () =>
        ok({ items: [summaryOf('operation-b')], unfinished: unfinishedItems }),
      status: async (request) =>
        ok(
          request.operationId === 'operation-b'
            ? terminalB
            : request.operationId === 'operation-a'
              ? blockingA
              : statusC
        ),
      start: startSpy,
      cancel: cancelSpy,
      subscribeProgress: (_scope, listener) => {
        progressListener = listener
        return () => undefined
      }
    })
    const saveCanvas = immediateSave()
    const host = await mountSceneGeneration(sceneOptions(client, saveCanvas))

    await waitFor(() => host.controller().status?.operationId === 'operation-b')
    expect(host.controller().startBlockedByGeneration).toBe(true)
    expect(host.controller().startBlockedReason).toContain('当前场景已有进行中的生成')

    await act(async () => {
      await host.controller().start()
    })
    await flush()
    expect(saveCanvas).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()

    await act(async () => {
      expect(host.controller().selectUnfinished('operation-a')).toBe(true)
    })
    expect(host.controller().status?.operationId).toBe('operation-a')
    expect(host.controller().status?.state).toBe('waiting')
    expect(host.controller().status?.canCancel).toBe(true)

    await act(async () => {
      await host.controller().cancel()
    })
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(host.controller().actionError).toBeNull()
    await waitFor(() => host.controller().status?.state === 'cancelled')
    expect(
      host.controller().unfinished.some((item) => item.operationId === 'operation-a')
    ).toBe(false)
    expect(host.controller().startBlockedReason).toBeNull()

    // 迟到的发现响应仍带回已终态的 A，不能复活旧阻断。
    unfinishedItems = [blockingA]
    await act(async () => {
      host.controller().refreshDiscovery()
    })
    await flush()
    await waitFor(() => host.controller().unfinished.length === 0)
    expect(host.controller().startBlockedReason).toBeNull()

    await act(async () => {
      await host.controller().start()
    })
    await waitFor(
      () =>
        host.controller().status?.operationId === 'operation-c' &&
        host.controller().status.state === 'running'
    )
    expect(saveCanvas).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      statusC = statusOf('operation-c', {
        state: 'succeeded',
        stage: 'completed',
        sequence: 99,
        mode: 'generate',
        canPause: false,
        canCancel: false,
        result: { commitId: 'commit-c' }
      })
      progressListener?.(statusC)
    })
    await waitFor(() => host.controller().status?.state === 'succeeded')
    expect(host.controller().unfinished.some((item) => item.operationId === 'operation-a')).toBe(
      false
    )
    expect(host.controller().startBlockedReason).toBeNull()

    // 终态缓存只排斥同操作旧项，不会排斥之后发现的新操作。
    const blockingD = statusOf('operation-d', {
      state: 'pending',
      stage: 'readingInput',
      stageMessage: '正在读取已保存编排与输入',
      mode: 'generate',
      blocksNewGeneration: true
    })
    unfinishedItems = [blockingA, blockingD]
    await act(async () => {
      host.controller().refreshDiscovery()
    })
    await flush()
    await waitFor(() => host.controller().unfinished.length === 1)
    expect(host.controller().unfinished.map((item) => item.operationId)).toEqual(['operation-d'])
    expect(host.controller().startBlockedReason).toContain('正在读取已保存编排与输入')
  })
})
