// @vitest-environment jsdom

/**
 * 代码门阻断 1 的真实页面状态机回归：空抽屉首次加载后启动 A、A 待审、
 * 从历史分叉自动进入 B、接受 B 至终态；全程不预置 A、不手动 refresh、不关抽屉。
 * 发现列表始终返回空，A 只能由当前状态权威及时入列。
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import type {
  SceneGenerationForkVO,
  SceneGenerationHistoryPageVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  useSceneGeneration,
  type SceneGenerationController,
  type UseSceneGenerationOptions
} from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const projectId = 'project-1'
const sceneId = 'scene-1'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function failed(code: number, msg: string): AjaxResult<never> {
  return { code, msg }
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
    state: 'pending',
    stage: 'readingInput',
    stageMessage: '正在读取已保存编排与输入',
    attempt: 1,
    sequence: 5,
    canPause: true,
    canResume: false,
    canCancel: true,
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

async function mountSceneGeneration(options: UseSceneGenerationOptions): Promise<{
  controller: () => SceneGenerationController
  unmount: () => Promise<void>
}> {
  let current: SceneGenerationController | null = null
  const Probe = (): null => {
    current = useSceneGeneration(options)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  await flush()
  return {
    controller: () => {
      if (current === null) throw new Error('场景生成 hook 尚未挂载')
      return current
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

it('空抽屉启动 A→等待→分叉 B→接受 B 终态：A 自动入列并阻止保存/启动，处理 A 后解除', async () => {
  const statuses = new Map<string, SceneGenerationRenderStatusVO>()
  let progressListener: ((event: SceneGenerationRenderProgressEventVO) => void) | null = null
  let bFork: SceneGenerationForkVO | null = null
  let startCalls = 0

  const client = {
    listHistory: vi.fn(async (): Promise<AjaxResult<SceneGenerationHistoryPageVO>> => {
      // 始终为空：A 只能由启动/进度状态及时入列，不能靠发现列表自动填充。
      return ok({ items: [], unfinished: [] })
    }),
    status: vi.fn(async (request: { operationId: string }) => {
      const found = statuses.get(request.operationId)
      return found ? ok(found) : failed(ErrorCodes.invalidRequest, '操作不存在')
    }),
    latest: vi.fn(async () => ok(null)),
    start: vi.fn(async () => {
      startCalls += 1
      const a = statusOf('operation-a', {
        state: 'running',
        stage: 'generating',
        stageMessage: 'AI 正在生成候选脚本',
        mode: 'generate',
        blocksNewGeneration: true
      })
      statuses.set('operation-a', a)
      return ok(a)
    }),
    fork: vi.fn(async () => {
      const b = statusOf('operation-b', {
        state: 'waiting',
        stage: 'waitingReview',
        stageMessage: '候选已就绪，等待你的决定',
        checkpointId: 'checkpoint-b',
        interaction: {
          interactionId: 'interaction-b',
          checkpointId: 'checkpoint-b',
          kind: 'review',
          message: '是否接受这个候选？',
          allowedReplies: ['accept', 'revise', 'discard']
        }
      })
      statuses.set('operation-b', b)
      bFork = {
        status: b,
        source: { summary: 'A 的候选', createdAt: '2026-11-22T00:00:00.000Z' }
      }
      return ok(bFork)
    }),
    reply: vi.fn(async () => {
      const succeeded = statusOf('operation-b', {
        state: 'succeeded',
        stage: 'completed',
        stageMessage: '作品已提交',
        checkpointId: 'checkpoint-b',
        canPause: false,
        canCancel: false,
        result: { commitId: 'commit-b' }
      })
      statuses.set('operation-b', succeeded)
      return ok(succeeded)
    }),
    cancel: vi.fn(async () => {
      const cancelled = statusOf('operation-a', {
        state: 'cancelled',
        stage: 'cancelled',
        stageMessage: '本次生成已取消',
        checkpointId: 'checkpoint-a',
        mode: 'generate',
        sequence: 30,
        canPause: false,
        canCancel: false
      })
      statuses.set('operation-a', cancelled)
      return ok(cancelled)
    }),
    subscribeProgress: vi.fn((_scope, listener) => {
      progressListener = listener
      return () => undefined
    })
  } as unknown as SceneGenerationClient

  const saveCanvas = vi.fn(async () => ({ ok: true as const }))
  const host = await mountSceneGeneration({
    projectClient: {
      ensureProjectWorkspace: vi.fn(async () => ok({}))
    } as unknown as ProjectClient,
    client,
    projectId,
    sceneId,
    canvasId: 'canvas-1',
    saveState: 'saved',
    pageBlocked: false,
    canvasReady: true,
    saveCanvas
  })
  cleanup.push(host.unmount)

  // 空抽屉首次加载完成：没有预置 A。
  await waitFor(() => host.controller().startBlockedReason === null)
  expect(host.controller().status).toBeNull()
  expect(host.controller().unfinished).toEqual([])

  // 点击启动 A：开始成功，当前状态权威立即把阻断入列。
  await act(async () => {
    await host.controller().start()
  })
  await waitFor(() => host.controller().status?.operationId === 'operation-a')
  expect(startCalls).toBe(1)
  expect(saveCanvas).toHaveBeenCalledTimes(1)
  expect(host.controller().unfinished.map((item) => item.operationId)).toEqual(['operation-a'])

  // A 进入等待（有检查点），发现列表仍为空，但入列项随状态更新。
  const waitingA = statusOf('operation-a', {
    state: 'waiting',
    stage: 'waitingReview',
    stageMessage: '候选已就绪，等待你的决定',
    checkpointId: 'checkpoint-a',
    mode: 'generate',
    blocksNewGeneration: true,
    sequence: 10
  })
  statuses.set('operation-a', waitingA)
  await act(async () => {
    progressListener?.(waitingA)
  })
  await waitFor(
    () =>
      host.controller().unfinished.find((item) => item.operationId === 'operation-a')?.state ===
      'waiting'
  )
  expect(host.controller().startBlockedByGeneration).toBe(true)

  // 历史分叉成功并自动进入 B；A 仍留在发现列表。
  await act(async () => {
    const forkOutcome = await host.controller().forkFromHistory({
      projectId,
      sceneId,
      threadId: 'thread-operation-a',
      branchId: 'branch-operation-a',
      checkpointId: 'checkpoint-a'
    })
    expect(forkOutcome).toMatchObject({ kind: 'forked', viewSwitched: true })
  })
  expect(bFork).not.toBeNull()
  await waitFor(() => host.controller().status?.operationId === 'operation-b')
  expect(host.controller().unfinished.map((item) => item.operationId)).toEqual(['operation-a'])
  expect(host.controller().startBlockedByGeneration).toBe(true)
  expect(host.controller().repairBlockedReason).toBeNull()

  // 接受 B 至终态；A 仍可见并可选中，普通启动在保存前被阻止。
  await act(async () => {
    await host.controller().accept()
  })
  await waitFor(() => host.controller().status?.state === 'succeeded')
  expect(host.controller().status?.operationId).toBe('operation-b')
  expect(host.controller().unfinished.map((item) => item.operationId)).toEqual(['operation-a'])
  expect(host.controller().startBlockedReason).toContain('当前场景已有进行中的生成')
  expect(host.controller().startBlockedReason).toContain('候选已就绪')
  expect(host.controller().startBlockedByGeneration).toBe(true)
  expect(saveCanvas).toHaveBeenCalledTimes(1)

  // A 在发现列表中可直接选中；选中后按原权限取消。
  expect(host.controller().unfinished.map((item) => item.operationId)).toEqual(['operation-a'])

  await act(async () => {
    await host.controller().start()
  })
  await flush()
  expect(saveCanvas).toHaveBeenCalledTimes(1)
  expect(startCalls).toBe(1)
  expect(host.controller().actionError?.kind).toBe('start')

  // 从历史选中 A 并按原权限取消；终态后列表与启动门禁解除。
  await act(async () => {
    expect(host.controller().selectUnfinished('operation-a')).toBe(true)
  })
  expect(host.controller().status?.operationId).toBe('operation-a')
  expect(host.controller().status?.canCancel).toBe(true)
  await act(async () => {
    await host.controller().cancel()
  })
  await waitFor(() => host.controller().status?.state === 'cancelled')
  expect(host.controller().unfinished).toEqual([])
  expect(host.controller().startBlockedReason).toBeNull()
  expect(host.controller().startBlockedByGeneration).toBe(false)

  // 全程没有靠发现列表自动填充，也没有为每个状态 tick 查磁盘。
  expect(client.listHistory).toHaveBeenCalledTimes(1)
}, 20_000)

it('发现读回开始后才启动的阻断不会被过期空列表抹掉；refreshDiscovery 返回可等待结果', async () => {
  const statuses = new Map<string, SceneGenerationRenderStatusVO>()
  const refreshRead = Promise.withResolvers<AjaxResult<SceneGenerationHistoryPageVO>>()
  let listCalls = 0
  const client = {
    listHistory: vi.fn(async () => {
      listCalls += 1
      return listCalls === 1 ? ok({ items: [], unfinished: [] }) : refreshRead.promise
    }),
    status: vi.fn(async (request: { operationId: string }) => {
      const found = statuses.get(request.operationId)
      return found ? ok(found) : failed(ErrorCodes.invalidRequest, '操作不存在')
    }),
    latest: vi.fn(async () => ok(null)),
    start: vi.fn(async () => {
      const a = statusOf('operation-a', {
        state: 'running',
        stage: 'generating',
        stageMessage: 'AI 正在生成候选脚本',
        mode: 'generate',
        blocksNewGeneration: true
      })
      statuses.set('operation-a', a)
      return ok(a)
    }),
    fork: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置分叉')),
    reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
    cancel: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置取消')),
    subscribeProgress: vi.fn(() => () => undefined)
  } as unknown as SceneGenerationClient

  const saveCanvas = vi.fn(async () => ({ ok: true as const }))
  const host = await mountSceneGeneration({
    projectClient: {
      ensureProjectWorkspace: vi.fn(async () => ok({}))
    } as unknown as ProjectClient,
    client,
    projectId,
    sceneId,
    canvasId: 'canvas-1',
    saveState: 'saved',
    pageBlocked: false,
    canvasReady: true,
    saveCanvas
  })
  cleanup.push(host.unmount)

  await waitFor(() => host.controller().startBlockedReason === null)
  // 发现读回已开始（此时后端还没有 A）。
  const pendingRefresh = host.controller().refreshDiscovery()
  await flush()
  expect(client.listHistory).toHaveBeenCalledTimes(2)

  // 读回等待期间启动 A：当前状态权威先把阻断入列。
  await act(async () => {
    await host.controller().start()
  })
  await waitFor(() => host.controller().status?.operationId === 'operation-a')
  expect(host.controller().unfinished.map((item) => item.operationId)).toEqual(['operation-a'])

  // 过期的空发现读回结束，不能把读回开始后才出现的阻断抹掉。
  await act(async () => {
    refreshRead.resolve(ok({ items: [], unfinished: [] }))
    await pendingRefresh
  })
  await expect(pendingRefresh).resolves.toEqual({ ok: true })
  await waitFor(() => host.controller().unfinished.length === 1)
  expect(host.controller().unfinished[0]?.operationId).toBe('operation-a')
  expect(host.controller().startBlockedReason).toContain('当前场景已有进行中的生成')
  expect(saveCanvas).toHaveBeenCalledTimes(1)

  // 读取失败返回可展示的错误信号，不吞成完成。
  client.listHistory = vi.fn(async () => failed(ErrorCodes.internalError, '发现读取失败'))
  await expect(host.controller().refreshDiscovery()).resolves.toEqual({
    ok: false,
    message: '发现读取失败'
  })
}, 20_000)

it('较旧的发现读回迟到时不把已退役阻断重新加入', async () => {
  const firstRead = Promise.withResolvers<AjaxResult<SceneGenerationHistoryPageVO>>()
  const secondRead = Promise.withResolvers<AjaxResult<SceneGenerationHistoryPageVO>>()
  const queuedReads = [firstRead, secondRead]
  let listCalls = 0
  const client = {
    listHistory: vi.fn(async () => {
      listCalls += 1
      if (listCalls === 1) return ok({ items: [], unfinished: [] })
      const queued = queuedReads.shift()
      if (!queued) throw new Error('发现读取次数超出预期')
      return queued.promise
    }),
    status: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置状态')),
    latest: vi.fn(async () => ok(null)),
    start: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置启动')),
    fork: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置分叉')),
    reply: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置回复')),
    cancel: vi.fn(async () => failed(ErrorCodes.internalError, '测试不配置取消')),
    subscribeProgress: vi.fn(() => () => undefined)
  } as unknown as SceneGenerationClient

  const host = await mountSceneGeneration({
    projectClient: {
      ensureProjectWorkspace: vi.fn(async () => ok({}))
    } as unknown as ProjectClient,
    client,
    projectId,
    sceneId,
    canvasId: 'canvas-1',
    saveState: 'saved',
    pageBlocked: false,
    canvasReady: true,
    saveCanvas: vi.fn(async () => ({ ok: true as const }))
  })
  cleanup.push(host.unmount)

  await waitFor(() => host.controller().startBlockedReason === null)
  const older = host.controller().refreshDiscovery()
  const newer = host.controller().refreshDiscovery()

  await act(async () => {
    secondRead.resolve(ok({ items: [], unfinished: [] }))
    await newer
  })
  expect(host.controller().unfinished).toEqual([])

  const staleBlocker = statusOf('operation-retired', {
    state: 'waiting',
    stage: 'waitingReview',
    stageMessage: '候选已就绪，等待你的决定',
    checkpointId: 'checkpoint-retired',
    mode: 'generate',
    blocksNewGeneration: true
  })
  await act(async () => {
    firstRead.resolve(ok({ items: [], unfinished: [staleBlocker] }))
    await older
  })
  await flush()
  expect(host.controller().unfinished).toEqual([])
  expect(host.controller().startBlockedReason).toBeNull()
}, 20_000)
