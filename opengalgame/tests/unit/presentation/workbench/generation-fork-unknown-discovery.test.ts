// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  SceneGenerationForkVO,
  SceneGenerationHistoryDetailVO,
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
  historyForkRecheckAction,
  historyForkUnconfirmedChecking,
  historyForkUnconfirmedFailed,
  historyForkUnconfirmedMessage,
  historyForkUnconfirmedRechecked,
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

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const projectId = 'project-1'
const sceneId = 'scene-1'
const sourceOperationId = 'operation-source'
const forkOperationId = 'operation-fork'

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

function statusOf(
  operationId: string,
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId,
    sceneId,
    operationId,
    threadId: 'thread-1',
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

function summaryOf(
  operationId: string,
  checkpointId: string,
  message: string
): SceneGenerationHistorySummaryVO {
  return {
    projectId,
    sceneId,
    operationId,
    threadId: 'thread-1',
    branchId: `branch-${operationId}`,
    checkpointId,
    boundary: 'waitingReview',
    stage: 'waitingReview',
    message,
    createdAt: '2026-11-20T12:00:00.000Z'
  }
}

const sourceSummary = summaryOf(
  sourceOperationId,
  'checkpoint-source',
  '来源候选已发布'
)
const forkSummary = summaryOf(forkOperationId, 'checkpoint-fork', '新分支候选已发布')

function historyPage(
  withCheckpointBranch: boolean,
  withUnfinishedBranch: boolean
): SceneGenerationHistoryPageVO {
  return {
    items: withCheckpointBranch ? [forkSummary, sourceSummary] : [sourceSummary],
    unfinished: withUnfinishedBranch
      ? [
          statusOf(forkOperationId, {
            state: 'pending',
            stage: 'readingInput',
            stageMessage: '新分支正在读取已保存编排'
          })
        ]
      : []
  }
}

type DiscoveryKind = 'none' | 'unfinished' | 'checkpoint'

interface Harness {
  readonly host: {
    readonly controller: () => SceneGenerationController
    readonly container: HTMLElement
    readonly unmount: () => Promise<void>
  }
  readonly forkSpy: Mock
  readonly listHistorySpy: Mock
  readonly subscribeSpy: Mock
  readonly gateDiscovery: () => Deferred<AjaxResult<SceneGenerationHistoryPageVO>>
  readonly releaseDiscovery: () => void
}

const mounted: Array<() => Promise<void>> = []

async function mountUnknownScenario(kind: DiscoveryKind): Promise<Harness> {
  const forkDeferred = deferred<AjaxResult<SceneGenerationForkVO>>()
  let branchCreated = false
  let discoveryGate: Deferred<AjaxResult<SceneGenerationHistoryPageVO>> | null = null
  const listHistorySpy = vi.fn(async (request: { limit?: number }) => {
    if (request.limit === 1 && discoveryGate !== null) return discoveryGate.promise
    return ok(
      historyPage(
        branchCreated && kind === 'checkpoint',
        branchCreated && kind === 'unfinished'
      )
    )
  })
  const subscribeSpy = vi.fn(() => () => undefined)
  const client = {
    listHistory: listHistorySpy,
    status: vi.fn(async (request: { operationId: string }) =>
      ok(
        request.operationId === forkOperationId
          ? statusOf(forkOperationId, {
              state: 'pending',
              stage: 'readingInput',
              stageMessage: '新分支正在读取已保存编排'
            })
          : statusOf(sourceOperationId)
      )
    ),
    latest: vi.fn(async () => ok(null)),
    start: vi.fn(async () => failed(ErrorCodes.internalError, '测试没有配置启动')),
    fork: vi.fn(() => forkDeferred.promise),
    readCheckpoint: vi.fn(async (request: { checkpointId: string }) =>
      ok({
        ...(request.checkpointId === 'checkpoint-fork' ? forkSummary : sourceSummary),
        canFork: true
      } as SceneGenerationHistoryDetailVO)
    ),
    subscribeProgress: subscribeSpy
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
  const onForked = vi.fn()
  const Probe = (): ReactElement => {
    const controller = useSceneGeneration(options)
    const forkUnknown = useForkUnknownRegistry({ projectId, sceneId })
    current = controller
    return createElement(GenerationHistory, {
      client,
      forkFromHistory: controller.forkFromHistory,
      forkUnknown,
      onForked,
      onRefreshDiscovery: controller.refreshDiscovery,
      projectId,
      sceneId,
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
  const host = {
    controller: () => {
      if (current === null) throw new Error('场景生成 hook 尚未挂载')
      return current
    },
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
  mounted.push(host.unmount)

  await waitFor(() => host.controller().status?.operationId === sourceOperationId)
  await click(container, '来源候选已发布')
  await waitFor(() => container.textContent?.includes('从这里分叉') ?? false)
  await click(container, '从这里分叉')
  await waitFor(() => vi.mocked(client.fork).mock.calls.length === 1)

  branchCreated = kind !== 'none'
  await act(async () => {
    forkDeferred.resolve(failed(ErrorCodes.communicationFailed, '与主进程通信失败'))
  })
  await flush()
  await waitFor(() => container.textContent?.includes(historyForkUnconfirmedTitle) ?? false)

  return {
    host,
    forkSpy: vi.mocked(client.fork),
    listHistorySpy,
    subscribeSpy,
    gateDiscovery: () => {
      const gate = deferred<AjaxResult<SceneGenerationHistoryPageVO>>()
      discoveryGate = gate
      return gate
    },
    releaseDiscovery: () => {
      discoveryGate = null
    }
  }
}

async function click(container: HTMLElement, text: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!button) throw new Error(`没有找到按钮：${text}`)
  await act(async () => {
    button.click()
  })
  await flush()
}

afterEach(async () => {
  while (mounted.length > 0) {
    const unmount = mounted.pop()
    await unmount?.()
  }
})

describe('分叉回执未知后的发现核对', () => {
  it('无检查点分支：重新核对刷新历史和发现后能找回，且不自动再创建', async () => {
    const harness = await mountUnknownScenario('unfinished')
    const readsBefore = harness.listHistorySpy.mock.calls.length
    const subscriptionsBefore = harness.subscribeSpy.mock.calls.length

    const text = harness.host.container.textContent ?? ''
    expect(text).toContain(historyForkUnconfirmedTitle)
    expect(text).toContain(historyForkUnconfirmedMessage)
    expect(text).not.toContain('从这里分叉')
    expect(harness.forkSpy).toHaveBeenCalledTimes(1)

    await click(harness.host.container, historyForkRecheckAction)
    await waitFor(
      () =>
        harness.host.container.textContent?.includes('已重新读取 AI 历史与待处理发现') ??
        false
    )
    expect(harness.listHistorySpy.mock.calls.length).toBeGreaterThan(readsBefore)

    await click(harness.host.container, historyForkViewListAction)
    await waitFor(
      () =>
        harness.host.container.textContent?.includes(historyForkUnknownBannerTitle) ?? false
    )
    const listText = harness.host.container.textContent ?? ''
    expect(listText).toContain('需要处理的操作')
    expect(listText).toContain('新分支正在读取已保存编排')
    expect(listText).toContain(historyForkUnknownBannerTitle)
    expect(listText).not.toContain('新分支已创建')
    expect(harness.forkSpy).toHaveBeenCalledTimes(1)
    expect(harness.host.controller().status?.operationId).toBe(sourceOperationId)
    expect(harness.subscribeSpy.mock.calls.length).toBe(subscriptionsBefore)
  })

  it('有检查点分支：重新核对刷新历史后能从记录找到，且不改当前视图与订阅', async () => {
    const harness = await mountUnknownScenario('checkpoint')
    const readsBefore = harness.listHistorySpy.mock.calls.length
    const subscriptionsBefore = harness.subscribeSpy.mock.calls.length

    await click(harness.host.container, historyForkRecheckAction)
    expect(harness.listHistorySpy.mock.calls.length).toBeGreaterThan(readsBefore)

    await click(harness.host.container, historyForkViewListAction)
    await waitFor(
      () => harness.host.container.textContent?.includes('新分支候选已发布') ?? false
    )
    const listText = harness.host.container.textContent ?? ''
    expect(listText).toContain('新分支候选已发布')
    expect(listText).toContain(historyForkUnknownBannerTitle)
    expect(listText).not.toContain('新分支已创建')
    expect(harness.forkSpy).toHaveBeenCalledTimes(1)
    expect(harness.host.controller().status?.operationId).toBe(sourceOperationId)
    expect(harness.subscribeSpy.mock.calls.length).toBe(subscriptionsBefore)
  })

  it('没有创建时核对后仍保持未知，不冒称成功', async () => {
    const harness = await mountUnknownScenario('none')
    const readsBefore = harness.listHistorySpy.mock.calls.length

    await click(harness.host.container, historyForkRecheckAction)
    expect(harness.listHistorySpy.mock.calls.length).toBeGreaterThan(readsBefore)

    await click(harness.host.container, historyForkViewListAction)
    await waitFor(
      () =>
        harness.host.container.textContent?.includes(historyForkUnknownBannerTitle) ?? false
    )
    const listText = harness.host.container.textContent ?? ''
    expect(listText).toContain(historyForkUnknownBannerTitle)
    expect(listText).not.toContain('新分支候选已发布')
    expect(listText).not.toContain('新分支已创建')
    expect(listText).not.toContain('需要处理的操作')
    expect(harness.forkSpy).toHaveBeenCalledTimes(1)
    expect(harness.host.controller().status?.operationId).toBe(sourceOperationId)
  })

  it('发现读取延迟或失败时不提前宣称完成，失败可重试', async () => {
    const harness = await mountUnknownScenario('unfinished')
    const gate = harness.gateDiscovery()

    await click(harness.host.container, historyForkRecheckAction)
    await flush()
    const checking = harness.host.container.textContent ?? ''
    expect(checking).toContain(historyForkUnconfirmedTitle)
    expect(checking).toContain(historyForkUnconfirmedChecking)
    expect(checking).not.toContain(historyForkUnconfirmedRechecked)
    expect(checking).toContain('没有收到创建结果')

    await act(async () => {
      gate.resolve(failed(ErrorCodes.internalError, '发现读取失败'))
    })
    await flush()
    await waitFor(
      () =>
        (harness.host.container.textContent ?? '').includes(historyForkUnconfirmedFailed)
    )
    const failedText = harness.host.container.textContent ?? ''
    expect(failedText).toContain(historyForkUnconfirmedTitle)
    expect(failedText).toContain(historyForkUnconfirmedFailed)
    expect(failedText).toContain('发现读取失败')
    expect(failedText).not.toContain(historyForkUnconfirmedRechecked)
    expect(failedText).not.toContain('新分支已创建')

    harness.releaseDiscovery()
    await click(harness.host.container, historyForkRecheckAction)
    await waitFor(
      () =>
        (harness.host.container.textContent ?? '').includes(historyForkUnconfirmedRechecked)
    )
    expect(harness.host.container.textContent).toContain(historyForkUnconfirmedTitle)

    await click(harness.host.container, historyForkViewListAction)
    await waitFor(
      () =>
        (harness.host.container.textContent ?? '').includes('新分支正在读取已保存编排')
    )
    expect(harness.host.container.textContent).not.toContain('新分支已创建')
    expect(harness.forkSpy).toHaveBeenCalledTimes(1)
  })
})
