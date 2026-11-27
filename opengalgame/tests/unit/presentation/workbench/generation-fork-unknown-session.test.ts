// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  SceneGenerationForkVO,
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
  historyForkUnconfirmedTitle,
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
    for (let index = 0; index < 40; index += 1) await Promise.resolve()
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error('等待条件没有在限定轮次内成立')
}

function summaryOf(operationId: string, message: string): SceneGenerationHistorySummaryVO {
  return {
    projectId,
    sceneId,
    operationId,
    threadId: `thread-${operationId}`,
    branchId: `branch-${operationId}`,
    checkpointId: `checkpoint-${operationId}`,
    boundary: 'waitingReview',
    stage: 'waitingReview',
    message,
    createdAt: '2026-11-20T12:00:00.000Z'
  }
}

function statusOf(operationId: string): SceneGenerationRenderStatusVO {
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
    previewAvailable: false
  }
}

const sourceA = summaryOf('operation-a', '来源 A')
const sourceB = summaryOf('operation-b', '来源 B')

const historyController = {
  items: [sourceA, sourceB],
  view: 'ready',
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  reload: vi.fn(async () => ({ ok: true as const })),
  retry: vi.fn(),
  loadMore: vi.fn()
}
historyState.current = historyController
detailState.current = {
  detail: { ...sourceA, canFork: true },
  loading: false,
  error: null,
  reload: vi.fn()
}

type Scope = { projectId: string; sceneId: string }

interface Host {
  readonly container: HTMLElement
  readonly controller: () => SceneGenerationController
  readonly forkSpy: Mock
  readonly forkDeferreds: Array<Deferred<AjaxResult<SceneGenerationForkVO>>>
  setShowHistory: (show: boolean) => Promise<void>
  setScope: (scope: Scope) => Promise<void>
  unmount: () => Promise<void>
}

const mounted: Host[] = []

async function mountHost(): Promise<Host> {
  const forkDeferreds: Array<Deferred<AjaxResult<SceneGenerationForkVO>>> = []
  const client = {
    listHistory: vi.fn(async () =>
      ok({ items: [sourceA, sourceB], unfinished: [] })
    ),
    status: vi.fn(async (request: { operationId: string }) =>
      ok(statusOf(request.operationId))
    ),
    latest: vi.fn(async () => ok(null)),
    start: vi.fn(async () => failed(ErrorCodes.internalError, '测试没有配置启动')),
    fork: vi.fn(() => {
      const pending = deferred<AjaxResult<SceneGenerationForkVO>>()
      forkDeferreds.push(pending)
      return pending.promise
    }),
    subscribeProgress: vi.fn(() => () => undefined)
  } as unknown as SceneGenerationClient
  const options: UseSceneGenerationOptions = {
    projectClient: {
      ensureProjectWorkspace: vi.fn(async () => ok({} as never))
    } as unknown as ProjectClient,
    client,
    projectId,
    sceneId,
    canvasId: 'canvas-1',
    saveState: 'saved' as WorkbenchSaveState,
    pageBlocked: false,
    canvasReady: true,
    saveCanvas: async () => ({ ok: true as const })
  }

  let current: SceneGenerationController | null = null
  let pageState = { options, showHistory: true, scope: { projectId, sceneId } }
  const PageHost = (): ReactElement => {
    const controller = useSceneGeneration({ ...pageState.options, ...pageState.scope })
    const forkUnknown = useForkUnknownRegistry(pageState.scope)
    current = controller
    return pageState.showHistory
      ? createElement(GenerationHistory, {
          client: pageState.options.client,
          forkFromHistory: controller.forkFromHistory,
          forkUnknown,
          onForked: vi.fn(),
          onRefreshDiscovery: async () => ({ ok: true as const }),
          projectId: pageState.scope.projectId,
          sceneId: pageState.scope.sceneId,
          unfinished: controller.unfinished
        })
      : createElement('div')
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(PageHost))
  })
  await flush()
  await waitFor(() => (container.textContent ?? '').includes('来源 A'))

  const host: Host = {
    container,
    controller: () => {
      if (current === null) throw new Error('场景生成 hook 尚未挂载')
      return current
    },
    forkSpy: vi.mocked(client.fork),
    forkDeferreds,
    setShowHistory: async (show) => {
      pageState = { ...pageState, showHistory: show }
      await act(async () => {
        root.render(createElement(PageHost))
      })
      await flush()
    },
    setScope: async (scope) => {
      pageState = { ...pageState, scope }
      await act(async () => {
        root.render(createElement(PageHost))
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

async function openDetail(container: HTMLElement, text: string): Promise<void> {
  await click(container, text)
  await waitFor(() => (container.textContent ?? '').includes('记录时间'))
}

async function forkUnknown(host: Host, source: string, message: string): Promise<void> {
  await openDetail(host.container, source)
  await waitFor(() => (host.container.textContent ?? '').includes('从这里分叉'))
  await click(host.container, '从这里分叉')
  const pending = host.forkDeferreds.at(-1)
  if (!pending) throw new Error('分叉请求没有发出')
  await act(async () => {
    pending.resolve(failed(ErrorCodes.communicationFailed, message))
  })
  await flush()
  await waitFor(
    () => (host.container.textContent ?? '').includes(historyForkUnconfirmedTitle)
  )
  await click(host.container, historyForkViewListAction)
}

function banner(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.wb-hist__fork-unknown')
}

afterEach(async () => {
  while (mounted.length > 0) {
    const host = mounted.pop()
    await host?.unmount()
  }
})

describe('未知分叉的页面级会话', () => {
  it('两个来源都保留，卸载重挂后仍在，只清对应项且跨场景不串', async () => {
    const host = await mountHost()

    await forkUnknown(host, '来源 A', 'A 通信失败')
    await forkUnknown(host, '来源 B', 'B 通信失败')

    await waitFor(() => (banner(host.container)?.textContent ?? '').includes('来源 B'))
    const firstBanner = banner(host.container)?.textContent ?? ''
    expect(firstBanner).toContain(historyForkUnknownBannerTitle)
    expect(firstBanner).toContain('来源 A')
    expect(firstBanner).toContain('来源 B')
    expect((firstBanner.match(/我已核对/g) ?? []).length).toBe(2)

    await host.setShowHistory(false)
    await host.setShowHistory(true)
    await waitFor(() => (host.container.textContent ?? '').includes('来源 B'))
    const remountedBanner = banner(host.container)?.textContent ?? ''
    expect(remountedBanner).toContain('来源 A')
    expect(remountedBanner).toContain('来源 B')
    expect(host.forkSpy).toHaveBeenCalledTimes(2)

    const itemA = Array.from(
      host.container.querySelectorAll('.wb-hist__fork-unknown-item')
    ).find((item) => item.textContent?.includes('来源 A'))
    if (!itemA) throw new Error('没有找到来源 A 的未知横幅项')
    const ackA = Array.from(itemA.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === historyForkAcknowledgeAction
    )
    if (!ackA) throw new Error('没有找到来源 A 的我已核对')
    await act(async () => {
      ackA.click()
    })
    await flush()

    const afterAck = banner(host.container)?.textContent ?? ''
    expect(afterAck).not.toContain('来源 A')
    expect(afterAck).toContain('来源 B')

    await openDetail(host.container, '来源 A')
    expect(host.container.textContent).toContain('从这里分叉')
    expect(host.container.textContent).not.toContain(historyForkUnconfirmedTitle)
    await click(host.container, '返回列表')

    await openDetail(host.container, '来源 B')
    expect(host.container.textContent).toContain(historyForkUnconfirmedTitle)
    expect(host.container.textContent).not.toContain('从这里分叉')
    await click(host.container, '返回列表')

    await host.setScope({ projectId, sceneId: 'scene-2' })
    expect(banner(host.container)).toBeNull()

    await host.setScope({ projectId, sceneId })
    await waitFor(() => (banner(host.container)?.textContent ?? '').includes('来源 B'))
    expect(banner(host.container)?.textContent).not.toContain('来源 A')
    expect(host.forkSpy).toHaveBeenCalledTimes(2)
  })
})
