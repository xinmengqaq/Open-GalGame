// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  SceneGenerationForkVO,
  SceneGenerationHistoryPageVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  historyForkAcknowledgeAction,
  historyForkCreateAgainAction,
  historyForkCreatedActiveHint,
  historyForkCreatedHint,
  historyForkCreatedMessage,
  historyForkCreatedTitle,
  historyForkRefreshAction,
  historyForkRecheckAction,
  historyForkUnconfirmedMessage,
  historyForkUnconfirmedTitle,
  historyForkUnknownBannerRechecked,
  historyForkUnknownBannerTitle,
  historyForkViewListAction
} from '@presentation/pages/workbench/drawer/generation/generationHistoryPresentation'
import { GenerationHistory } from '@presentation/pages/workbench/drawer/generation/GenerationHistory'
import {
  useSceneGeneration,
  type SceneGenerationController,
  type UseSceneGenerationOptions
} from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'
import { useForkUnknownRegistry } from '@presentation/pages/workbench/drawer/generation/useForkUnknownRegistry'
import { FORK_UNCONFIRMED_MESSAGE } from '@presentation/pages/workbench/drawer/generation/useGenerationActions'

const historyState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>
}))
const detailState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>
}))

vi.mock('@presentation/pages/workbench/drawer/generation/useGenerationHistory', () => ({
  useGenerationHistory: () => historyState.current
}))

vi.mock('@presentation/pages/workbench/drawer/generation/useGenerationHistoryDetail', () => ({
  useGenerationHistoryDetail: () => detailState.current
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const projectId = 'project-1'
const sceneId = 'scene-1'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function failed<T = never>(code: number, msg: string): AjaxResult<T> {
  return { code, msg }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
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
    state: 'succeeded',
    stage: 'completed',
    stageMessage: '作品已提交',
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
    boundary: 'waitingReview',
    stage: 'waitingReview',
    message: '候选已发布，等待审阅',
    createdAt: '2026-11-20T12:00:00.000Z'
  }
}

function forkOf(
  operationId: string,
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationForkVO {
  return {
    status: statusOf(operationId, {
      state: 'running',
      stage: 'generating',
      stageMessage: '等待你的回复 · 第 5 / 6 步',
      ...overrides
    }),
    source: { summary: '来源记录', createdAt: '2026-11-20T11:00:00.000Z' }
  }
}

function historyController(items: readonly SceneGenerationHistorySummaryVO[]): {
  controller: Record<string, unknown>
  reload: Mock
} {
  const reload = vi.fn(async () => ({ ok: true as const }))
  return {
    reload,
    controller: {
      items,
      view: 'ready',
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: false,
      reload,
      retry: vi.fn(),
      loadMore: vi.fn()
    }
  }
}

type MountedHistory = {
  readonly controller: () => SceneGenerationController
  readonly container: HTMLElement
  readonly onForked: Mock
  unmount: () => Promise<void>
}

const mounted: MountedHistory[] = []

async function mountHistory(options: UseSceneGenerationOptions): Promise<MountedHistory> {
  let current: SceneGenerationController | null = null
  const onForked = vi.fn()
  const Probe = (): ReactElement => {
    const controller = useSceneGeneration(options)
    const forkUnknown = useForkUnknownRegistry({
      projectId: options.projectId,
      sceneId: options.sceneId
    })
    current = controller
    const refreshDiscovery = async (): Promise<{ ok: true }> => {
      await controller.refreshDiscovery()
      return { ok: true }
    }
    return createElement(GenerationHistory, {
      client: options.client,
      forkFromHistory: controller.forkFromHistory,
      forkUnknown,
      onForked,
      onRefreshDiscovery: refreshDiscovery,
      projectId: options.projectId,
      sceneId: options.sceneId,
      unfinished: controller.unfinished
    })
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  await flush()
  const host: MountedHistory = {
    controller: () => {
      if (current === null) throw new Error('场景生成 hook 尚未挂载')
      return current
    },
    container,
    onForked,
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

function sceneOptions(client: SceneGenerationClient): UseSceneGenerationOptions {
  return {
    projectClient,
    client,
    projectId,
    sceneId,
    canvasId: 'canvas-1',
    saveState: 'saved' as WorkbenchSaveState,
    pageBlocked: false,
    canvasReady: true,
    saveCanvas: async () => ({ ok: true as const })
  }
}

function fakeClient(hooks: {
  listHistory: () => Promise<AjaxResult<SceneGenerationHistoryPageVO>>
  status: (operationId: string) => Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  start: () => Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  fork: () => Promise<AjaxResult<SceneGenerationForkVO>>
}): SceneGenerationClient {
  return {
    listHistory: vi.fn(hooks.listHistory),
    status: vi.fn((request: { operationId: string }) => hooks.status(request.operationId)),
    latest: vi.fn(async () => ok(null)),
    start: vi.fn(hooks.start),
    fork: vi.fn(hooks.fork),
    subscribeProgress: vi.fn(() => () => undefined)
  } as unknown as SceneGenerationClient
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!button) throw new Error(`没有找到按钮：${text}`)
  return button
}

async function click(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonByText(container, text).click()
  })
  await flush()
}

async function openDetail(container: HTMLElement): Promise<void> {
  await click(container, '候选已发布，等待审阅')
  await waitFor(() => container.textContent?.includes('从这里分叉') ?? false)
}

interface Harness {
  readonly host: MountedHistory
  readonly forkDeferreds: Deferred<AjaxResult<SceneGenerationForkVO>>[]
  readonly forkSpy: Mock
  readonly listHistory: Mock
  readonly markForkCreated: () => void
}

async function mountStartThenForkHarness(): Promise<Harness> {
  const history = historyController([summaryOf('operation-a')])
  historyState.current = history.controller
  detailState.current = {
    detail: { ...summaryOf('operation-a'), canFork: true },
    loading: false,
    error: null,
    reload: vi.fn()
  }
  const forkDeferreds: Deferred<AjaxResult<SceneGenerationForkVO>>[] = []
  let forkCreated = false
  const listHistory = vi.fn(async () =>
    ok({
      items: [summaryOf('operation-a')],
      unfinished: forkCreated
        ? [
            statusOf('operation-fork', {
              state: 'waiting',
              stage: 'waitingReview',
              stageMessage: '等待你的回复 · 第 5 / 6 步',
              canResumeUnfinished: true,
              updatedAt: '2026-11-20T12:10:00.000Z'
            })
          ]
        : []
    })
  )
  const started = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
  const client = fakeClient({
    listHistory,
    status: async (operationId) => {
      if (operationId === 'operation-b') {
        return ok(
          statusOf('operation-b', {
            state: 'running',
            stage: 'generating',
            stageMessage: '生成候选 · 第 3 / 6 步'
          })
        )
      }
      return ok(statusOf(operationId))
    },
    start: () => started.promise,
    fork: () => {
      const pending = deferred<AjaxResult<SceneGenerationForkVO>>()
      forkDeferreds.push(pending)
      return pending.promise
    }
  })
  const host = await mountHistory(sceneOptions(client))
  await waitFor(() => host.controller().status?.operationId === 'operation-a')
  await openDetail(host.container)

  let startPromise!: Promise<void>
  await act(async () => {
    startPromise = host.controller().start()
  })
  await waitFor(() => vi.mocked(client.start).mock.calls.length === 1)

  /* 分叉与启动同时在途：先让分叉发出，再让启动结果先落地。 */
  await click(host.container, '从这里分叉')
  await waitFor(() => vi.mocked(client.fork).mock.calls.length === 1)

  await act(async () => {
    started.resolve(
      ok(
        statusOf('operation-b', {
          state: 'running',
          stage: 'generating',
          stageMessage: '生成候选 · 第 3 / 6 步'
        })
      )
    )
    await startPromise
  })
  await flush()
  expect(host.controller().status?.operationId).toBe('operation-b')

  return {
    host,
    forkDeferreds,
    forkSpy: vi.mocked(client.fork),
    listHistory,
    markForkCreated: () => {
      forkCreated = true
    }
  }
}

async function createBranchWhileViewSwitched(
  harness: Harness,
  fork: SceneGenerationForkVO = forkOf('operation-fork')
): Promise<void> {
  harness.markForkCreated()
  await act(async () => {
    harness.forkDeferreds[0]?.resolve(ok(fork))
  })
  await flush()
  await waitFor(
    () => harness.host.container.textContent?.includes(historyForkCreatedTitle) ?? false
  )
}

describe('历史分叉结果到可见动作', () => {
  it('已创建但视图未切换：显示创建事实和找回入口，不出现重试语义', async () => {
    const harness = await mountStartThenForkHarness()
    await createBranchWhileViewSwitched(harness)

    expect(harness.host.controller().status?.operationId).toBe('operation-b')
    expect(harness.host.onForked).not.toHaveBeenCalled()

    const text = harness.host.container.textContent ?? ''
    expect(text).toContain(historyForkCreatedTitle)
    expect(text).toContain(historyForkCreatedMessage)
    expect(text).toContain(historyForkCreatedActiveHint)
    expect(text).toContain(historyForkRefreshAction)
    expect(text).not.toContain(historyForkCreateAgainAction)
    expect(text).not.toContain('可以直接重试')
    expect(text).not.toContain('原记录和分支保持不变')
    expect(text).not.toContain('从这里分叉')
    expect(harness.host.container.querySelector('.wb-hist__fork-error')).toBeNull()
    expect(harness.host.container.querySelector('.wb-hist__fork--created')).not.toBeNull()
  })

  it('刷新历史后回到列表，并从“需要处理的操作”找到新分支', async () => {
    const harness = await mountStartThenForkHarness()
    await createBranchWhileViewSwitched(harness)
    await waitFor(() =>
      harness.host.controller().unfinished.some((entry) => entry.operationId === 'operation-fork')
    )
    const listReads = harness.listHistory.mock.calls.length

    await click(harness.host.container, historyForkRefreshAction)

    expect(harness.host.container.textContent).not.toContain(historyForkCreatedTitle)
    await waitFor(() => harness.listHistory.mock.calls.length > listReads)
    await waitFor(
      () => harness.host.container.textContent?.includes('需要处理的操作') ?? false
    )
    const text = harness.host.container.textContent ?? ''
    expect(text).toContain('等待你的回复 · 第 5 / 6 步')
    expect(text).toContain('可继续')
    expect(harness.host.controller().status?.operationId).toBe('operation-b')
  })

  it('“再创建一条分支”是明确的新意图，仍可正常创建并切换', async () => {
    const harness = await mountStartThenForkHarness()
    await createBranchWhileViewSwitched(
      harness,
      forkOf('operation-fork', {
        state: 'failed',
        stage: 'failed',
        stageMessage: '生成已停止'
      })
    )
    const created = harness.host.container.textContent ?? ''
    expect(created).toContain(historyForkCreatedHint)
    expect(created).toContain(historyForkCreateAgainAction)

    await click(harness.host.container, historyForkCreateAgainAction)
    await waitFor(() => harness.forkSpy.mock.calls.length === 2)
    await act(async () => {
      harness.forkDeferreds[1]?.resolve(ok(forkOf('operation-fork-second')))
    })
    await flush()

    expect(harness.forkSpy).toHaveBeenCalledTimes(2)
    expect(harness.host.onForked).toHaveBeenCalledTimes(1)
    expect(harness.host.controller().status?.operationId).toBe('operation-fork-second')
  })

  it('确实失败按原契约显示失败原因与重试入口', async () => {
    const history = historyController([summaryOf('operation-a')])
    historyState.current = history.controller
    detailState.current = {
      detail: { ...summaryOf('operation-a'), canFork: true },
      loading: false,
      error: null,
      reload: vi.fn()
    }
    const forked = deferred<AjaxResult<SceneGenerationForkVO>>()
    const client = fakeClient({
      listHistory: async () => ok({ items: [summaryOf('operation-a')], unfinished: [] }),
      status: async (operationId) => ok(statusOf(operationId)),
      start: async () => failed(ErrorCodes.internalError, '测试没有配置启动'),
      fork: () => forked.promise
    })
    const host = await mountHistory(sceneOptions(client))
    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    await openDetail(host.container)

    await click(host.container, '从这里分叉')
    await waitFor(() => vi.mocked(client.fork).mock.calls.length === 1)
    await act(async () => {
      forked.resolve(failed(ErrorCodes.operationConflict, '来源对话仍有未结束操作'))
    })
    await flush()

    const text = host.container.textContent ?? ''
    expect(text).toContain('来源对话仍有未结束操作')
    expect(text).toContain('原记录和分支保持不变')
    expect(text).toContain('可以直接重试')
    expect(text).not.toContain(historyForkCreatedTitle)
    expect(host.container.querySelector('.wb-hist__fork-error')).not.toBeNull()
  })

  it('结果未明仍提示先核对，不冒充确认失败', async () => {
    const history = historyController([summaryOf('operation-a')])
    historyState.current = history.controller
    detailState.current = {
      detail: { ...summaryOf('operation-a'), canFork: true },
      loading: false,
      error: null,
      reload: vi.fn()
    }
    const forked = deferred<AjaxResult<SceneGenerationForkVO>>()
    const client = fakeClient({
      listHistory: async () => ok({ items: [summaryOf('operation-a')], unfinished: [] }),
      status: async (operationId) => ok(statusOf(operationId)),
      start: async () => failed(ErrorCodes.internalError, '测试没有配置启动'),
      fork: () => forked.promise
    })
    const host = await mountHistory(sceneOptions(client))
    await waitFor(() => host.controller().status?.operationId === 'operation-a')
    await openDetail(host.container)

    await click(host.container, '从这里分叉')
    await waitFor(() => vi.mocked(client.fork).mock.calls.length === 1)
    await act(async () => {
      forked.resolve(failed(ErrorCodes.communicationFailed, '与主进程通信失败'))
    })
    await flush()

    const text = host.container.textContent ?? ''
    expect(text).toContain('与主进程通信失败')
    expect(text).toContain(historyForkUnconfirmedTitle)
    expect(text).toContain(historyForkUnconfirmedMessage)
    expect(text).toContain(historyForkRecheckAction)
    expect(text).toContain(historyForkViewListAction)
    expect(text).not.toContain('从这里分叉')
    expect(text).not.toContain('可以直接重试')
    expect(text).not.toContain(historyForkCreatedTitle)

    await click(host.container, historyForkRecheckAction)
    expect(history.reload).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      host.container.textContent?.includes('已重新读取 AI 历史与待处理发现') ?? false
    )
    expect(host.container.textContent).toContain(historyForkUnconfirmedTitle)
    expect(host.container.textContent).not.toContain('从这里分叉')

    await click(host.container, historyForkViewListAction)
    await waitFor(
      () => host.container.textContent?.includes(historyForkUnknownBannerTitle) ?? false
    )
    const banner = host.container.textContent ?? ''
    expect(banner).toContain(historyForkUnknownBannerRechecked)
    expect(banner).toContain(historyForkAcknowledgeAction)
    expect(banner).not.toContain(historyForkCreatedTitle)
    expect(vi.mocked(client.listHistory)).toHaveBeenCalled()
    expect(vi.mocked(client.fork)).toHaveBeenCalledTimes(1)
    expect(host.controller().status?.operationId).toBe('operation-a')

    await click(host.container, '候选已发布，等待审阅')
    await waitFor(
      () => host.container.textContent?.includes(historyForkUnconfirmedTitle) ?? false
    )
    expect(host.container.textContent).not.toContain('从这里分叉')
  })

  it('分叉请求在视图切走后抛错：不猜已创建或已失败，只提示核对', async () => {
    const harness = await mountStartThenForkHarness()

    await act(async () => {
      harness.forkDeferreds[0]?.reject(new Error('与主进程通信失败'))
    })
    await flush()
    await waitFor(
      () => harness.host.container.textContent?.includes(FORK_UNCONFIRMED_MESSAGE) ?? false
    )

    const text = harness.host.container.textContent ?? ''
    expect(text).toContain(FORK_UNCONFIRMED_MESSAGE)
    expect(text).toContain(historyForkUnconfirmedTitle)
    expect(text).toContain(historyForkUnconfirmedMessage)
    expect(text).toContain(historyForkRecheckAction)
    expect(text).not.toContain('从这里分叉')
    expect(text).not.toContain('可以直接重试')
    expect(text).not.toContain(historyForkCreatedTitle)
    expect(harness.host.controller().status?.operationId).toBe('operation-b')
  })
})
