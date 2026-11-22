import { describe, expect, it, vi } from 'vitest'

import type {
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import {
  GenerationActionRequestRegistry,
  GenerationSelectionSession,
  performGenerationAction,
  visibleActionFailure,
  type GenerationSelectionToken
} from '@presentation/pages/workbench/drawer/generation/generationSelectionSession'
import {
  GENERATION_SELECTION_LOST_EMPTY_NOTICE,
  GENERATION_SELECTION_LOST_NOTICE,
  GENERATION_SELECTION_MISMATCH_NOTICE,
  readGenerationHistory,
  reconcileGenerationStatus,
  reloadGenerationView,
  type GenerationViewReloadTarget
} from '@presentation/pages/workbench/drawer/generation/useGenerationStatus'

const scope = { projectId: 'project-1', sceneId: 'scene-1' }
const scopeKey = `${scope.projectId}|${scope.sceneId}`

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function failed(code: number, msg: string, reason?: string): AjaxResult<never> {
  return { code, msg, ...(reason === undefined ? {} : { reason }) }
}

/** 仓储确认操作不存在时的唯一结构化事实；与检查点读取失败区分。 */
function missing(): AjaxResult<never> {
  return failed(
    ErrorCodes.invalidRequest,
    '该场景生成操作不存在',
    FailureReasons.sceneGenerationOperationMissing
  )
}

function status(
  operationId: string,
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: scope.projectId,
    sceneId: scope.sceneId,
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

function summary(operationId: string): SceneGenerationHistorySummaryVO {
  return {
    ...scope,
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
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function selectionSession(operationId: string): {
  session: GenerationSelectionSession
  token: GenerationSelectionToken
} {
  const session = new GenerationSelectionSession()
  session.setScope(scopeKey)
  session.observe(operationId)
  return { session, token: session.token() }
}

function reloadHarness(
  session: GenerationSelectionSession,
  token: GenerationSelectionToken,
  pinnedOperationId: string | null,
  client: Pick<GenerationViewReloadTarget['client'], 'listHistory' | 'status' | 'latest'>,
  overrides: Partial<GenerationViewReloadTarget> = {}
): {
  target: GenerationViewReloadTarget
  applied: SceneGenerationRenderStatusVO[]
  notices: (string | null)[]
  errors: (string | null)[]
  unfinished: readonly SceneGenerationRenderStatusVO[][]
  cleared: () => number
} {
  const applied: SceneGenerationRenderStatusVO[] = []
  const notices: (string | null)[] = []
  const errors: (string | null)[] = []
  const unfinished: readonly SceneGenerationRenderStatusVO[][] = []
  const clearStatus = vi.fn()
  return {
    target: {
      client,
      projectId: scope.projectId,
      sceneId: scope.sceneId,
      pinnedOperationId,
      token,
      isAborted: () => false,
      isSelectionCurrent: (value) => session.isCurrent(value),
      currentStatus: () => null,
      clearPin: () => session.clearPin(),
      applyStatus: (value) => applied.push(value),
      clearStatus,
      setUnfinished: (value) => unfinished.push(value),
      setLoadError: (value) => errors.push(value),
      setUnavailable: () => undefined,
      setSelectionNotice: (value) => notices.push(value),
      ...overrides
    },
    applied,
    notices,
    errors,
    unfinished,
    cleared: () => clearStatus.mock.calls.length
  }
}

describe('重载按显式选择的操作身份刷新', () => {
  it('作者进入其它操作后丢弃旧选择，重载回到最新事实', () => {
    const { session } = selectionSession('operation-old')
    session.pin('operation-old')

    expect(session.pinnedForCurrentView()).toBe('operation-old')
    session.observe('operation-new')
    expect(session.pinnedForCurrentView()).toBeNull()
  })

  it('没有显式选择时重载仍采用最新历史', async () => {
    const { session, token } = selectionSession('operation-old')
    const latest = status('operation-new', { sequence: 9 })
    const harness = reloadHarness(session, token, null, {
      listHistory: vi.fn(async () => ok({ items: [summary('operation-new')], unfinished: [] })),
      status: vi.fn(async () => ok(latest)),
      latest: vi.fn()
    })

    await reloadGenerationView(harness.target)

    expect(harness.applied.map((value) => value.operationId)).toEqual(['operation-new'])
    expect(harness.notices).toEqual([null])
  })

  it('最新历史更晚时仍按选中的旧操作读取，不跳回来源', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const old = status('operation-old', { state: 'pending', stage: 'preparing' })
    const latest = status('operation-source', { sequence: 9 })
    const oldRead = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const listHistory = vi.fn(async () =>
      ok({ items: [summary('operation-source')], unfinished: [old] })
    )
    const readStatus = vi.fn(async (request: { operationId: string }) =>
      request.operationId === 'operation-old' ? oldRead.promise : ok(latest)
    )
    const harness = reloadHarness(session, token, 'operation-old', {
      listHistory,
      status: readStatus,
      latest: vi.fn()
    })

    const reloading = reloadGenerationView(harness.target)
    await vi.waitFor(() => {
      expect(readStatus).toHaveBeenCalledWith({ ...scope, operationId: 'operation-old' })
    })
    oldRead.resolve(ok(old))
    await reloading

    expect(harness.applied.map((value) => value.operationId)).toEqual(['operation-old'])
    expect(harness.notices).toEqual([null])
    expect(harness.unfinished.at(-1)?.map((value) => value.operationId)).toEqual([
      'operation-old'
    ])
    expect(session.pinnedForCurrentView()).toBe('operation-old')
  })

  it('确认记录不存在时回退最新并给出固定提示，不静默改看别的任务', async () => {
    const { session, token } = selectionSession('operation-missing')
    session.pin('operation-missing')
    const fallback = status('operation-source', { sequence: 9 })
    const listHistory = vi.fn(async () =>
      ok({ items: [summary('operation-source')], unfinished: [] })
    )
    const readStatus = vi.fn(async (request: { operationId: string }) =>
      request.operationId === 'operation-missing' ? missing() : ok(fallback)
    )
    const harness = reloadHarness(session, token, 'operation-missing', {
      listHistory,
      status: readStatus,
      latest: vi.fn()
    })

    await reloadGenerationView(harness.target)

    expect(harness.applied.map((value) => value.operationId)).toEqual(['operation-source'])
    expect(harness.notices).toEqual([GENERATION_SELECTION_LOST_NOTICE])
    expect(harness.errors).toEqual([null])
    expect(session.pinnedForCurrentView()).toBeNull()
  })

  it('记录不存在且没有可回退的历史时清空当前视图并如实提示没有可显示内容', async () => {
    const { session, token } = selectionSession('operation-missing')
    session.pin('operation-missing')
    const listHistory = vi.fn(async () => ok({ items: [], unfinished: [] }))
    const harness = reloadHarness(session, token, 'operation-missing', {
      listHistory,
      status: vi.fn(async () => missing()),
      latest: vi.fn(async () => ok(null))
    })

    await reloadGenerationView(harness.target)

    expect(harness.applied).toEqual([])
    expect(harness.cleared()).toBe(1)
    expect(harness.notices).toEqual([GENERATION_SELECTION_LOST_EMPTY_NOTICE])
    expect(session.pinnedForCurrentView()).toBeNull()
  })

  it('操作存在但旧检查点读取失败（invalidRequest 无结构化缺失原因）时保留选择与视图', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const listHistory = vi.fn(async () =>
      ok({ items: [summary('operation-source')], unfinished: [status('operation-old')] })
    )
    const readStatus = vi.fn(async (request: { operationId: string }) =>
      request.operationId === 'operation-old'
        ? failed(ErrorCodes.invalidRequest, '历史检查点不存在')
        : ok(status('operation-source'))
    )
    const harness = reloadHarness(session, token, 'operation-old', {
      listHistory,
      status: readStatus,
      latest: vi.fn()
    })

    await reloadGenerationView(harness.target)

    expect(harness.applied).toEqual([])
    expect(harness.cleared()).toBe(0)
    expect(harness.notices).toEqual([])
    expect(harness.errors).toEqual(['历史检查点不存在'])
    expect(session.pinnedForCurrentView()).toBe('operation-old')

    await reloadGenerationView(harness.target)
    expect(readStatus).toHaveBeenLastCalledWith({ ...scope, operationId: 'operation-old' })
  })

  it('目标只是暂时读取失败时保留当前视图和选择，不拿最新记录顶替', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const listHistory = vi.fn(async () =>
      ok({ items: [summary('operation-source')], unfinished: [status('operation-old')] })
    )
    const harness = reloadHarness(session, token, 'operation-old', {
      listHistory,
      status: vi.fn(async (request: { operationId: string }) =>
        request.operationId === 'operation-old'
          ? failed(ErrorCodes.communicationFailed, '状态读取失败')
          : ok(status('operation-source'))
      ),
      latest: vi.fn()
    })

    await reloadGenerationView(harness.target)

    expect(harness.applied).toEqual([])
    expect(harness.cleared()).toBe(0)
    expect(harness.errors).toEqual(['状态读取失败'])
    expect(harness.unfinished.at(-1)?.map((value) => value.operationId)).toEqual([
      'operation-old'
    ])
    expect(session.pinnedForCurrentView()).toBe('operation-old')
  })

  it('读回身份与所选不一致时保留当前视图，不把别的操作当成所选事实', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const harness = reloadHarness(session, token, 'operation-old', {
      listHistory: vi.fn(async () => ok({ items: [], unfinished: [status('operation-old')] })),
      status: vi.fn(async () => ok(status('operation-other'))),
      latest: vi.fn(async () => ok(status('operation-old')))
    })

    await reloadGenerationView(harness.target)

    expect(harness.applied).toEqual([])
    expect(harness.errors).toEqual([GENERATION_SELECTION_MISMATCH_NOTICE])
    expect(session.pinnedForCurrentView()).toBe('operation-old')
  })

  it('重载途中切到别的操作再切回，迟到结果作废但仍刷新未完成列表', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const targetRead = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const targetStarted = deferred<void>()
    const harness = reloadHarness(session, token, 'operation-old', {
      listHistory: vi.fn(async () => ok({ items: [], unfinished: [status('operation-old')] })),
      status: vi.fn(async () => {
        targetStarted.resolve()
        return targetRead.promise
      }),
      latest: vi.fn(async () => ok(null))
    })

    const reloading = reloadGenerationView(harness.target)
    await targetStarted.promise
    session.observe('operation-other')
    session.observe('operation-old')
    targetRead.resolve(ok(status('operation-old', { sequence: 8 })))
    await reloading

    expect(harness.applied).toEqual([])
    expect(harness.notices).toEqual([])
    expect(harness.unfinished).toHaveLength(1)
  })

  it('目标读取失败若选择已变，错误不再归到后来选择', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const targetRead = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const targetStarted = deferred<void>()
    const harness = reloadHarness(session, token, 'operation-old', {
      listHistory: vi.fn(async () => ok({ items: [], unfinished: [status('operation-old')] })),
      status: vi.fn(async () => {
        targetStarted.resolve()
        return targetRead.promise
      }),
      latest: vi.fn(async () => ok(null))
    })

    const reloading = reloadGenerationView(harness.target)
    await targetStarted.promise
    session.observe('operation-other')
    targetRead.resolve(failed(ErrorCodes.communicationFailed, '旧操作读取失败'))
    await reloading

    expect(harness.errors).toEqual([])
    expect(harness.unfinished).toHaveLength(1)
  })

  it('重载途中切场景后旧场景结果不再写回，旧选择也不会带过去', async () => {
    const { session, token } = selectionSession('operation-old')
    session.pin('operation-old')
    const targetRead = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const targetStarted = deferred<void>()
    let aborted = false
    const harness = reloadHarness(
      session,
      token,
      'operation-old',
      {
        listHistory: vi.fn(async () => ok({ items: [], unfinished: [status('operation-old')] })),
        status: vi.fn(async () => {
          targetStarted.resolve()
          return targetRead.promise
        }),
        latest: vi.fn(async () => ok(null))
      },
      { isAborted: () => aborted }
    )

    const reloading = reloadGenerationView(harness.target)
    await targetStarted.promise
    aborted = true
    session.setScope('project-2|scene-1')
    targetRead.resolve(ok(status('operation-old', { sequence: 8 })))
    await reloading

    expect(harness.applied).toEqual([])
    expect(harness.notices).toEqual([])
    expect(harness.unfinished).toEqual([])
    expect(session.pinnedForCurrentView()).toBeNull()
    expect(session.isCurrent(token)).toBe(false)
  })
})

describe('未完成操作分页读取', () => {
  it('合并全部未完成页、按 operationId 去重、过滤其它场景并防游标循环', async () => {
    const pageOne = {
      items: [],
      unfinished: [status('operation-1'), status('operation-1')],
      unfinishedNextCursor: 'cursor-1'
    }
    const pageTwo = {
      items: [],
      unfinished: [
        status('operation-2'),
        status('operation-2', { projectId: 'project-2' })
      ],
      unfinishedNextCursor: 'cursor-2'
    }
    const pageThree = {
      items: [],
      unfinished: [status('operation-1'), status('operation-3')],
      unfinishedNextCursor: 'cursor-1'
    }
    const listHistory = vi.fn(
      async (request: { unfinishedCursor?: string }) => {
        if (request.unfinishedCursor === undefined) return ok(pageOne)
        if (request.unfinishedCursor === 'cursor-1') return ok(pageTwo)
        return ok(pageThree)
      }
    )
    const readStatus = vi.fn()
    const readLatest = vi.fn(async () => ok(status('operation-1')))

    const loaded = await readGenerationHistory(
      { listHistory, status: readStatus, latest: readLatest } as never,
      scope.projectId,
      scope.sceneId
    )

    expect(loaded).toMatchObject({ kind: 'status' })
    expect(loaded.kind === 'status' ? loaded.unfinished.map((item) => item.operationId) : []).toEqual([
      'operation-1',
      'operation-2',
      'operation-3'
    ])
    expect(listHistory.mock.calls.map(([request]) => request.unfinishedCursor)).toEqual([
      undefined,
      'cursor-1',
      'cursor-2'
    ])
    expect(listHistory).toHaveBeenNthCalledWith(1, {
      projectId: scope.projectId,
      sceneId: scope.sceneId,
      limit: 1,
      unfinishedLimit: 100
    })
    expect(readStatus).not.toHaveBeenCalled()
    expect(readLatest).toHaveBeenCalledOnce()
  })

  it('后续未完成页读取失败时明确报错，不静默丢掉更早记录', async () => {
    const listHistory = vi.fn(async (request: { unfinishedCursor?: string }) =>
      request.unfinishedCursor === undefined
        ? ok({
            items: [],
            unfinished: [status('operation-1')],
            unfinishedNextCursor: 'cursor-1'
          })
        : failed(ErrorCodes.communicationFailed, '更早的未完成记录没有读出来')
    )

    await expect(
      readGenerationHistory(
        { listHistory, status: vi.fn(), latest: vi.fn() } as never,
        scope.projectId,
        scope.sceneId
      )
    ).resolves.toEqual({
      kind: 'error',
      message: '更早的未完成记录没有读出来',
      forbidden: false
    })
  })
})

describe('动作响应按发起身份与代次收割', () => {
  it('正常结果写回当前操作并结束登记', async () => {
    const { session, token } = selectionSession('operation-a')
    const registry = new GenerationActionRequestRegistry()
    const request = deferred<string>()
    const applied: string[] = []
    const stale: string[] = []
    const settled = vi.fn()
    const running = performGenerationAction({
      registry,
      token,
      kind: 'reply',
      isCurrent: (value) => session.isCurrent(value),
      request: () => request.promise,
      onResult: (value) => applied.push(value),
      onFailure: () => undefined,
      onStale: (value) => stale.push(value),
      onSettled: settled
    })

    expect(registry.visibleKind(scopeKey, 'operation-a')).toBe('reply')
    request.resolve('late-success')
    await expect(running).resolves.toBe('settled')
    expect(applied).toEqual(['late-success'])
    expect(stale).toEqual([])
    expect(settled).toHaveBeenCalledOnce()
    expect(registry.visibleKind(scopeKey, 'operation-a')).toBeNull()
  })

  it('切到别的操作后迟到成功不写回，并作为 stale 结果丢弃', async () => {
    const { session, token } = selectionSession('operation-a')
    const registry = new GenerationActionRequestRegistry()
    const request = deferred<string>()
    const applied: string[] = []
    const stale: string[] = []
    const running = performGenerationAction({
      registry,
      token,
      kind: 'verifyResult',
      isCurrent: (value) => session.isCurrent(value),
      request: () => request.promise,
      onResult: (value) => applied.push(value),
      onFailure: () => undefined,
      onStale: (value) => stale.push(value)
    })

    session.observe('operation-b')
    request.resolve('old-success')
    await running

    expect(applied).toEqual([])
    expect(stale).toEqual(['old-success'])
    expect(registry.visibleKind(scopeKey, 'operation-b')).toBeNull()
  })

  it('切走再切回同一操作，迟到成功仍不能覆盖后来选择', async () => {
    const { session, token } = selectionSession('operation-a')
    const registry = new GenerationActionRequestRegistry()
    const request = deferred<string>()
    const applied: string[] = []
    const stale: string[] = []
    const running = performGenerationAction({
      registry,
      token,
      kind: 'reply',
      isCurrent: (value) => session.isCurrent(value),
      request: () => request.promise,
      onResult: (value) => applied.push(value),
      onFailure: () => undefined,
      onStale: (value) => stale.push(value)
    })

    session.observe('operation-b')
    session.observe('operation-a')
    request.resolve('old-success')
    await running

    expect(applied).toEqual([])
    expect(stale).toEqual(['old-success'])
    expect(session.isCurrent(token)).toBe(false)
  })

  it('切场景后迟到失败不显示在新场景', async () => {
    const { session, token } = selectionSession('operation-a')
    const registry = new GenerationActionRequestRegistry()
    const request = deferred<string>()
    const failures: string[] = []
    const running = performGenerationAction({
      registry,
      token,
      kind: 'resume',
      isCurrent: (value) => session.isCurrent(value),
      request: () => request.promise,
      onResult: () => undefined,
      onFailure: (failure) => failures.push(failure.message)
    })

    session.setScope('project-2|scene-1')
    request.reject(new AppException({ code: ErrorCodes.communicationFailed, msg: '旧场景失败' }))
    await running

    expect(failures).toEqual([])
    expect(registry.visibleKind('project-2|scene-1', 'operation-a')).toBeNull()
  })

  it('当前选择上的失败按发起身份归因；切走再切回后旧错误不再可见', async () => {
    const { session, token } = selectionSession('operation-a')
    const registry = new GenerationActionRequestRegistry()
    const request = deferred<string>()
    let record: Parameters<typeof visibleActionFailure>[0] = null
    const running = performGenerationAction({
      registry,
      token,
      kind: 'verifyResult',
      isCurrent: (value) => session.isCurrent(value),
      request: () => request.promise,
      onResult: () => undefined,
      onFailure: (failure) => {
        record = {
          scope: token.scope,
          operationId: token.operationId,
          epoch: token.epoch,
          value: failure
        }
      }
    })

    request.reject(new AppException({ code: ErrorCodes.internalError, msg: '核对失败' }))
    await running
    expect(visibleActionFailure(record, (value) => session.isCurrent(value))).toMatchObject({
      kind: 'verifyResult',
      message: '核对失败'
    })

    session.observe('operation-b')
    expect(visibleActionFailure(record, (value) => session.isCurrent(value))).toBeNull()
    session.observe('operation-a')
    expect(visibleActionFailure(record, (value) => session.isCurrent(value))).toBeNull()
  })

  it('同一操作上的第二个动作直接 busy，切到别的操作后仍可正常发起', async () => {
    const { session, token } = selectionSession('operation-a')
    const registry = new GenerationActionRequestRegistry()
    const first = deferred<string>()
    const second = deferred<string>()
    const firstApplied: string[] = []
    const secondApplied: string[] = []
    const firstRun = performGenerationAction({
      registry,
      token,
      kind: 'reply',
      isCurrent: (value) => session.isCurrent(value),
      request: () => first.promise,
      onResult: (value) => firstApplied.push(value),
      onFailure: () => undefined
    })

    await expect(
      performGenerationAction({
        registry,
        token,
        kind: 'verifyResult',
        isCurrent: (value) => session.isCurrent(value),
        request: () => second.promise,
        onResult: (value) => secondApplied.push(value),
        onFailure: () => undefined
      })
    ).resolves.toBe('busy')

    session.observe('operation-b')
    const otherToken = session.token()
    const otherRun = performGenerationAction({
      registry,
      token: otherToken,
      kind: 'reply',
      isCurrent: (value) => session.isCurrent(value),
      request: () => second.promise,
      onResult: (value) => secondApplied.push(value),
      onFailure: () => undefined
    })

    second.resolve('b-result')
    await otherRun
    expect(secondApplied).toEqual(['b-result'])

    first.resolve('a-result')
    await firstRun
    expect(firstApplied).toEqual([])
    expect(registry.visibleKind(scopeKey, 'operation-a')).toBeNull()
    expect(registry.visibleKind(scopeKey, 'operation-b')).toBeNull()
  })
})

describe('进度收敛按发起身份与代次写回', () => {
  it('切换操作后迟到的状态收敛不写回', async () => {
    const { session, token } = selectionSession('operation-a')
    const request = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const applied: string[] = []
    const running = reconcileGenerationStatus({
      client: { status: () => request.promise },
      projectId: scope.projectId,
      sceneId: scope.sceneId,
      operationId: 'operation-a',
      token,
      isCancelled: () => false,
      isSelectionCurrent: (value) => session.isCurrent(value),
      applyStatus: (value) => applied.push(value.operationId)
    })

    session.observe('operation-b')
    request.resolve(ok(status('operation-a', { state: 'running', stage: 'generating' })))
    await expect(running).resolves.toBe('stale')
    expect(applied).toEqual([])
  })

  it('切走再切回同一操作后迟到收敛仍作废', async () => {
    const { session, token } = selectionSession('operation-a')
    const request = deferred<AjaxResult<SceneGenerationRenderStatusVO>>()
    const applied: string[] = []
    const running = reconcileGenerationStatus({
      client: { status: () => request.promise },
      projectId: scope.projectId,
      sceneId: scope.sceneId,
      operationId: 'operation-a',
      token,
      isCancelled: () => false,
      isSelectionCurrent: (value) => session.isCurrent(value),
      applyStatus: (value) => applied.push(value.operationId)
    })

    session.observe('operation-b')
    session.observe('operation-a')
    request.resolve(ok(status('operation-a', { state: 'running', stage: 'generating' })))
    await expect(running).resolves.toBe('stale')
    expect(applied).toEqual([])
  })

  it('当前选择上正常写回，终态返回 terminal', async () => {
    const { session, token } = selectionSession('operation-a')
    const applied: string[] = []
    const running = reconcileGenerationStatus({
      client: { status: async () => ok(status('operation-a')) },
      projectId: scope.projectId,
      sceneId: scope.sceneId,
      operationId: 'operation-a',
      token,
      isCancelled: () => false,
      isSelectionCurrent: (value) => session.isCurrent(value),
      applyStatus: (value) => applied.push(value.operationId)
    })

    await expect(running).resolves.toBe('terminal')
    expect(applied).toEqual(['operation-a'])
  })
})
