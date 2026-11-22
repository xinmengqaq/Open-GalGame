import { useCallback, useEffect, useRef, useState } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { failureOf } from '@presentation/feedback/failure'

import {
  appendProgressStep,
  isTerminalState,
  mergeRenderStatus,
  type GenerationProgressStep
} from './generationPresentation'
import {
  GenerationSelectionSession,
  generationScopeKey,
  type GenerationSelectionToken
} from './generationSelectionSession'
import type { MutableRef } from './useGenerationDraft'

type Scoped<T> = { scope: string; value: T }

/** 发现读取的完成信号；调用方可等待后再宣称“已重新读取”。 */
export type GenerationDiscoveryRefreshResult = { ok: true } | { ok: false; message: string }

type KnownBlocker = {
  status: SceneGenerationRenderStatusVO
  /** 该事实最近一次由当前状态权威确认的序号；用于判断发现读回是否已过期。 */
  epoch: number
}

type DiscoveryFacts = {
  scope: string
  /** 本地已确认终态的操作；迟到的发现响应不能把它们复活。 */
  terminalOperationIds: Set<string>
  /** 当前状态权威确认会阻断新的普通生成的操作；发现读回必须合并这些事实。 */
  blockers: Map<string, KnownBlocker>
}

/**
 * 本地状态权威：终态操作是最终事实，已知阻断保存最新安全投影。
 * 切换 scope 时丢弃旧事实，避免把缓存带到新场景。
 */
function discoveryFactsFor(ref: MutableRef<DiscoveryFacts>, scopeKey: string): DiscoveryFacts {
  if (ref.current.scope !== scopeKey)
    ref.current = {
      scope: scopeKey,
      terminalOperationIds: new Set(),
      blockers: new Map()
    }
  return ref.current
}

type ScopedError = {
  scope: string
  value: string
  /** 目标专属错误绑定发起请求的选择；场景级读取失败没有该字段。 */
  token?: GenerationSelectionToken
}

type ProgressNotice = { operationId: string; message: string; epoch: number }

/** 显式选中的记录被后端确认不存在时的固定提示；不静默回退。 */
export const GENERATION_SELECTION_LOST_NOTICE = '所选生成记录已不存在，已显示当前场景最新状态。'

/** 选中的记录不存在，且当前场景也没有可回退的最新状态：如实说没有可显示内容。 */
export const GENERATION_SELECTION_LOST_EMPTY_NOTICE =
  '所选生成记录已不存在，当前场景没有可显示的最新状态。'

/** 选中记录读回的身份与请求不一致：保留当前视图，不把别的记录当所选事实。 */
export const GENERATION_SELECTION_MISMATCH_NOTICE = '所选生成记录读取异常，已保留当前视图。'

/**
 * 只有仓储以结构化事实肯定“该操作不存在”才允许清掉显式选择。
 * `invalidRequest` 也可能来自检查点缺失/损坏或身份不符，不能凭码判定。
 */
export function generationOperationMissing(
  result: { readonly code: number; readonly reason?: string }
): boolean {
  return (
    result.code === ErrorCodes.invalidRequest &&
    result.reason === FailureReasons.sceneGenerationOperationMissing
  )
}

/**
 * 打开抽屉时只读历史和状态，不核对工作区。历史第一页同时带出需要作者处理的操作
 * （无检查点遗留或带检查点待核对）；未完成操作按专用游标合并全部页，避免超过
 * 响应上限时静默丢掉更早记录。历史为空时再读最近一次执行。全程只读，不恢复、
 * 不写状态、不调用模型。
 */
export async function readGenerationHistory(
  client: Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>,
  projectId: string,
  sceneId: string
): Promise<
  | { kind: 'empty'; unfinished: readonly SceneGenerationRenderStatusVO[] }
  | {
      kind: 'status'
      status: SceneGenerationRenderStatusVO
      unfinished: readonly SceneGenerationRenderStatusVO[]
    }
  | { kind: 'error'; message: string; forbidden: boolean }
> {
  const history = await client.listHistory({
    projectId,
    sceneId,
    limit: 1,
    unfinishedLimit: 100
  })
  if (history.code !== ErrorCodes.success || !history.data) {
    return {
      kind: 'error',
      message: history.msg,
      forbidden: history.code === ErrorCodes.forbidden
    }
  }
  const collected = [...history.data.unfinished]
  const seenCursors = new Set<string>()
  let cursor = history.data.unfinishedNextCursor
  while (cursor !== undefined && !seenCursors.has(cursor)) {
    seenCursors.add(cursor)
    const page = await client.listHistory({
      projectId,
      sceneId,
      limit: 1,
      unfinishedCursor: cursor,
      unfinishedLimit: 100
    })
    if (page.code !== ErrorCodes.success || !page.data) {
      return { kind: 'error', message: page.msg, forbidden: false }
    }
    collected.push(...page.data.unfinished)
    cursor = page.data.unfinishedNextCursor
  }
  const seenOperations = new Set<string>()
  const unfinished = collected.filter((status) => {
    if (status.projectId !== projectId || status.sceneId !== sceneId) return false
    if (seenOperations.has(status.operationId)) return false
    seenOperations.add(status.operationId)
    return true
  })
  const latest = history.data.items[0]
  if (!latest) {
    const recent = await client.latest({ projectId, sceneId })
    if (
      recent.code === ErrorCodes.success &&
      recent.data &&
      recent.data.projectId === projectId &&
      recent.data.sceneId === sceneId
    ) {
      return { kind: 'status', status: recent.data, unfinished }
    }
    /* 最近一次读取失败仍按空处理：历史已成功读空是当前权威事实。 */
    const fallback = unfinished[0]
    return fallback
      ? { kind: 'status', status: fallback, unfinished }
      : { kind: 'empty', unfinished }
  }
  const result = await client.status({ projectId, sceneId, operationId: latest.operationId })
  if (result.code !== ErrorCodes.success || !result.data) {
    return { kind: 'error', message: result.msg, forbidden: false }
  }
  if (
    result.data.projectId !== projectId ||
    result.data.sceneId !== sceneId ||
    result.data.operationId !== latest.operationId
  ) {
    return {
      kind: 'error',
      message: GENERATION_SELECTION_MISMATCH_NOTICE,
      forbidden: false
    }
  }
  return { kind: 'status', status: result.data, unfinished }
}

/**
 * 只从已读取的未完成操作中选择，切换当前运行视图；不恢复、不写状态。
 * 操作不在当前列表或不属于当前场景时返回 null。
 */
export function unfinishedSelectionOf(
  unfinished: readonly SceneGenerationRenderStatusVO[],
  operationId: string,
  scope: { projectId: string; sceneId: string }
): SceneGenerationRenderStatusVO | null {
  return (
    unfinished.find(
      (status) =>
        status.operationId === operationId &&
        status.projectId === scope.projectId &&
        status.sceneId === scope.sceneId
    ) ?? null
  )
}

const statusReconcileMs = 4_000

export type GenerationReconcileOutcome = 'applied' | 'terminal' | 'stale'

/**
 * 4s 收敛的一次状态读取。响应回来时只有发起身份与代次仍被选中才写回；
 * 切走、切回或切场景后的迟到读取只返回 stale，不改当前视图。
 */
export async function reconcileGenerationStatus(options: {
  readonly client: Pick<SceneGenerationClient, 'status'>
  readonly projectId: string
  readonly sceneId: string
  readonly operationId: string
  readonly token: GenerationSelectionToken
  readonly isCancelled: () => boolean
  readonly isSelectionCurrent: (token: GenerationSelectionToken) => boolean
  readonly applyStatus: (status: SceneGenerationRenderStatusVO) => void
}): Promise<GenerationReconcileOutcome> {
  const result = await options.client.status({
    projectId: options.projectId,
    sceneId: options.sceneId,
    operationId: options.operationId
  })
  if (options.isCancelled() || !options.isSelectionCurrent(options.token)) return 'stale'
  if (result.code !== ErrorCodes.success || !result.data) return 'applied'
  if (
    result.data.projectId !== options.projectId ||
    result.data.sceneId !== options.sceneId ||
    result.data.operationId !== options.operationId
  ) {
    return 'stale'
  }
  options.applyStatus(result.data)
  return isTerminalState(result.data.state) ? 'terminal' : 'applied'
}

export type GenerationViewRead =
  | {
      readonly kind: 'status'
      readonly status: SceneGenerationRenderStatusVO
      readonly unfinished: readonly SceneGenerationRenderStatusVO[]
      /** 显式选择的记录已不存在，status 只是明确的回退结果。 */
      readonly lostSelection: boolean
    }
  | {
      readonly kind: 'empty'
      readonly unfinished: readonly SceneGenerationRenderStatusVO[]
      readonly lostSelection: boolean
    }
  | {
      kind: 'error'
      message: string
      forbidden: boolean
      target: boolean
      unfinished?: readonly SceneGenerationRenderStatusVO[]
    }
  | { kind: 'cancelled' }

/**
 * 把一次重载结果写回页面。只有发起时的选择（作用域、操作、代次）仍是当前选择
 * 才改写当前视图；未完成列表属于场景事实，即使选择已变化也刷新。
 * 显式选择的记录确认不存在时清 pin 并回退，同时留下固定提示，不静默改看别的任务。
 */
export type GenerationViewReloadTarget = {
  readonly client: Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>
  readonly projectId: string
  readonly sceneId: string
  readonly pinnedOperationId: string | null
  readonly token: GenerationSelectionToken
  readonly isAborted: () => boolean
  readonly isSelectionCurrent: (token: GenerationSelectionToken) => boolean
  readonly currentStatus: () => SceneGenerationRenderStatusVO | null
  readonly clearPin: () => void
  readonly applyStatus: (status: SceneGenerationRenderStatusVO) => void
  readonly clearStatus: () => void
  readonly setUnfinished: (unfinished: readonly SceneGenerationRenderStatusVO[]) => void
  /** 第二参数为 true 时错误只属于发起请求的操作/代次，选择变化后隐藏。 */
  readonly setLoadError: (message: string | null, target?: boolean) => void
  readonly setUnavailable: (message: string | null) => void
  readonly setSelectionNotice: (message: string | null) => void
}

export type GenerationViewReloadOutcome = 'applied' | 'error' | 'stale' | 'cancelled'

export async function reloadGenerationView(
  target: GenerationViewReloadTarget
): Promise<GenerationViewReloadOutcome> {
  const view = await readGenerationView(
    target.client,
    target.projectId,
    target.sceneId,
    target.pinnedOperationId,
    target.isAborted
  )
  if (target.isAborted() || view.kind === 'cancelled') return 'cancelled'
  if (view.kind === 'error') {
    if (view.unfinished !== undefined) {
      target.setUnavailable(null)
      target.setUnfinished(view.unfinished)
    }
    /* 目标读取失败只属于发起时选中的操作，选择变化后不再显示。 */
    if (view.target && !target.isSelectionCurrent(target.token)) return 'stale'
    target.setLoadError(view.message, view.target)
    if (view.forbidden) target.setUnavailable(view.message)
    return 'error'
  }
  target.setUnavailable(null)
  target.setUnfinished(view.unfinished)
  if (!target.isSelectionCurrent(target.token)) return 'stale'
  if (view.kind === 'empty') {
    if (view.lostSelection) {
      target.clearPin()
      target.clearStatus()
      target.setSelectionNotice(GENERATION_SELECTION_LOST_EMPTY_NOTICE)
      target.setLoadError(null)
      return 'applied'
    }
    const current = target.currentStatus()
    if (current === null || isTerminalState(current.state)) target.clearStatus()
    target.setSelectionNotice(null)
    target.setLoadError(null)
    return 'applied'
  }
  if (view.lostSelection) {
    target.clearPin()
    target.applyStatus(view.status)
    target.setSelectionNotice(GENERATION_SELECTION_LOST_NOTICE)
  } else {
    target.applyStatus(view.status)
    target.setSelectionNotice(null)
  }
  target.setLoadError(null)
  return 'applied'
}
export async function readGenerationView(
  client: Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>,
  projectId: string,
  sceneId: string,
  pinnedOperationId: string | null,
  isCancelled: () => boolean = () => false
): Promise<GenerationViewRead> {
  const history = await readGenerationHistory(client, projectId, sceneId)
  if (isCancelled()) return { kind: 'cancelled' }
  if (history.kind === 'error') return { ...history, target: false }
  if (pinnedOperationId === null) return { ...history, lostSelection: false }

  const target = await client.status({ projectId, sceneId, operationId: pinnedOperationId })
  if (isCancelled()) return { kind: 'cancelled' }
  if (target.code === ErrorCodes.success && target.data) {
    if (
      target.data.projectId !== projectId ||
      target.data.sceneId !== sceneId ||
      target.data.operationId !== pinnedOperationId
    ) {
      return {
        kind: 'error',
        message: GENERATION_SELECTION_MISMATCH_NOTICE,
        forbidden: false,
        target: true,
        unfinished: history.unfinished
      }
    }
    return {
      kind: 'status',
      status: target.data,
      unfinished: history.unfinished,
      lostSelection: false
    }
  }
  if (!generationOperationMissing(target)) {
    return {
      kind: 'error',
      message: target.msg,
      forbidden: false,
      target: true,
      unfinished: history.unfinished
    }
  }
  const fallback = history.kind === 'status' ? history.status : null
  return fallback
    ? { kind: 'status', status: fallback, unfinished: history.unfinished, lostSelection: true }
    : { kind: 'empty', unfinished: history.unfinished, lostSelection: true }
}

function useLiveStatusReconcile(
  client: SceneGenerationClient,
  projectId: string,
  sceneId: string,
  liveOperationId: string | null,
  selection: GenerationSelectionSession,
  applyStatus: (status: SceneGenerationRenderStatusVO) => void
): void {
  useEffect(() => {
    if (!liveOperationId) return
    const token = selection.token()
    let cancelled = false
    let timer: number | null = null
    const reconcile = async (): Promise<void> => {
      const outcome = await reconcileGenerationStatus({
        client,
        projectId,
        sceneId,
        operationId: liveOperationId,
        token,
        isCancelled: () => cancelled,
        isSelectionCurrent: (value) => selection.isCurrent(value),
        applyStatus
      })
      if (cancelled || outcome === 'stale' || outcome === 'terminal') return
      timer = window.setTimeout(() => {
        void reconcile()
      }, statusReconcileMs)
    }
    void reconcile()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [applyStatus, client, liveOperationId, projectId, sceneId, selection])
}

interface UseGenerationStatusOptions {
  readonly client: SceneGenerationClient
  readonly projectId: string
  readonly sceneId: string
  readonly statusRef: MutableRef<SceneGenerationRenderStatusVO | null>
  readonly resetDraft: () => void
}

/** 当前场景任务状态的核对事实；未知与读取失败都不能放行启动。 */
export type GenerationStatusCheck = 'checking' | 'ready' | 'failed'

export interface UseGenerationStatusResult {
  readonly status: SceneGenerationRenderStatusVO | null
  readonly loading: boolean
  /** 当前场景是否已经核对过任务状态：首次读取、切场景和重载期间为 checking。 */
  readonly statusCheck: GenerationStatusCheck
  readonly loadError: string | null
  readonly unavailableReason: string | null
  readonly unfinished: readonly SceneGenerationRenderStatusVO[]
  readonly progress: readonly GenerationProgressStep[]
  readonly progressNotice: string | null
  /** 显式选择的记录失效时的固定提示；只在当前场景显示。 */
  readonly selectionNotice: string | null
  readonly reload: () => void
  /**
   * 只重读当前场景的未完成操作发现，不写回当前视图或选择。
   * 返回可等待完成信号：读取失败、异常或作用域已变化时返回 ok:false。
   */
  readonly refreshDiscovery: () => Promise<GenerationDiscoveryRefreshResult>
  readonly applyStatus: (incoming: SceneGenerationRenderStatusVO) => void
  /**
   * 作者动作成功后安装它返回的视图。若进入的是另一个操作，先登记显式切换，
   * 使此前已派发、迟到的动作不再有资格写回或把错误贴到新视图。
   */
  readonly applyActionStatus: (incoming: SceneGenerationRenderStatusVO) => void
  /** 只从已读取列表切换当前视图；不恢复。成功后记住该任务，重载按身份刷新。 */
  readonly selectUnfinished: (operationId: string) => boolean
  readonly scopedStatus: () => SceneGenerationRenderStatusVO | null
  readonly scope: string
  readonly scopeRef: MutableRef<string>
  readonly statusRef: MutableRef<SceneGenerationRenderStatusVO | null>
  /** 发起请求时捕获；响应后必须用 isSelectionCurrent 核对。 */
  readonly selectionToken: () => GenerationSelectionToken
  readonly isSelectionCurrent: (token: GenerationSelectionToken) => boolean
  /** 作者显式切换视图的代次；被动状态落地不改变，用于区分读回与真正切走。 */
  readonly selectionIntent: () => number
}

/**
 * 当前生成状态、历史、进度订阅与 4s 收敛的唯一所有者。
 * 关闭抽屉不取消任务；状态和订阅随页面身份存活，reload 只重新核对后端事实。
 * 作者显式选择旧任务后，重载按该操作身份刷新，不因最新历史更晚而跳回来源。
 */
export function useGenerationStatus({
  client,
  projectId,
  sceneId,
  statusRef,
  resetDraft
}: UseGenerationStatusOptions): UseGenerationStatusResult {
  const [status, setStatus] = useState<SceneGenerationRenderStatusVO | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewCheck, setViewCheck] = useState<{
    scope: string
    phase: GenerationStatusCheck
  } | null>(null)
  const [loadError, setLoadError] = useState<ScopedError | null>(null)
  const [unavailable, setUnavailable] = useState<Scoped<string> | null>(null)
  const [unfinished, setUnfinished] = useState<
    Scoped<readonly SceneGenerationRenderStatusVO[]> | null
  >(null)
  const [progress, setProgress] = useState<readonly GenerationProgressStep[]>([])
  const [progressNotice, setProgressNotice] = useState<Scoped<ProgressNotice> | null>(null)
  const [selectionNotice, setSelectionNotice] = useState<Scoped<string> | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const scope = generationScopeKey(projectId, sceneId)
  const scopeRef = useRef(scope)
  const discoveryFactsRef = useRef<DiscoveryFacts>({
    scope,
    terminalOperationIds: new Set(),
    blockers: new Map()
  })
  const discoveryReadIdRef = useRef(0)
  const appliedDiscoveryReadIdRef = useRef(0)
  const statusEpochRef = useRef(0)
  const [selection] = useState(() => new GenerationSelectionSession())
  /* 渲染期同步作用域：旧场景的 token 在切场景后的第一次渲染就立即失效。 */
  selection.setScope(scope)

  useEffect(() => {
    scopeRef.current = scope
  }, [scope])

  /* statusRef 只由 applyStatus/clearStatus 同步写入；不从渲染 state 回灌，
     避免较慢的一帧把刚写入的权威状态覆盖回旧值。 */

  const reload = useCallback((): void => {
    setReloadNonce((count) => count + 1)
  }, [])

  /**
   * 合并一次完整发现读回：本地终态优先，已知阻断按最新序号覆盖。
   * 读取启动后由当前状态新增的阻断，即使该读回还没有它，也不能被抹掉；
   * 读取启动前已知、但这之后新读回已不再列出的阻断，信任新读回移除，
   * 避免缓存永久保留外部已处理的操作。迟到的旧读取不覆盖已应用的更新读取。
   */
  const applyDiscovery = useCallback(
    (
      scopeKey: string,
      items: readonly SceneGenerationRenderStatusVO[],
      readId: number,
      readEpoch: number
    ): void => {
      if (scopeRef.current !== scopeKey || readId < appliedDiscoveryReadIdRef.current) return
      appliedDiscoveryReadIdRef.current = readId
      const facts = discoveryFactsFor(discoveryFactsRef, scopeKey)
      const merged = new Map<string, SceneGenerationRenderStatusVO>()
      for (const item of items) {
        if (isTerminalState(item.state)) {
          facts.terminalOperationIds.add(item.operationId)
          facts.blockers.delete(item.operationId)
          continue
        }
        if (facts.terminalOperationIds.has(item.operationId)) continue
        const existing = merged.get(item.operationId)
        merged.set(item.operationId, existing ? mergeRenderStatus(existing, item) : item)
        if (item.blocksNewGeneration === true) {
          const known = facts.blockers.get(item.operationId)
          facts.blockers.set(item.operationId, {
            status: known ? mergeRenderStatus(known.status, item) : item,
            epoch: known?.epoch ?? readEpoch
          })
        } else if ((facts.blockers.get(item.operationId)?.epoch ?? 0) <= readEpoch) {
          facts.blockers.delete(item.operationId)
        }
      }
      for (const [operationId, known] of facts.blockers) {
        if (facts.terminalOperationIds.has(operationId)) {
          facts.blockers.delete(operationId)
          continue
        }
        const existing = merged.get(operationId)
        if (existing) {
          merged.set(operationId, mergeRenderStatus(existing, known.status))
          continue
        }
        if (known.epoch > readEpoch) {
          merged.set(operationId, known.status)
          continue
        }
        /* 读回开始前就已知、这次又不再列出：视作外部已处理，不再保留旧阻断。 */
        facts.blockers.delete(operationId)
      }
      setUnfinished({ scope: scopeKey, value: [...merged.values()] })
    },
    []
  )

  /** 只刷新发现列表；不套用历史最新状态，避免把当前运行视图切回旧记录。 */
  const refreshDiscovery = useCallback(async (): Promise<GenerationDiscoveryRefreshResult> => {
    const key = scope
    const readId = ++discoveryReadIdRef.current
    const readEpoch = statusEpochRef.current
    try {
      const result = await readGenerationHistory(client, projectId, sceneId)
      if (scopeRef.current !== key) return { ok: false, message: '场景已切换，发现没有刷新' }
      if (result.kind === 'error') return { ok: false, message: result.message }
      applyDiscovery(key, result.unfinished, readId, readEpoch)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: failureOf(error).msg }
    }
  }, [applyDiscovery, client, projectId, sceneId, scope])

  const selectionToken = useCallback(
    (): GenerationSelectionToken => selection.token(),
    [selection]
  )

  const isSelectionCurrent = useCallback(
    (token: GenerationSelectionToken): boolean => selection.isCurrent(token),
    [selection]
  )

  const selectionIntent = useCallback((): number => selection.explicitIntent(), [selection])

  const clearStatus = useCallback((): void => {
    const hadStatus = statusRef.current !== null
    statusRef.current = null
    selection.observe(null)
    setStatus(null)
    setProgress([])
    if (hadStatus) {
      resetDraft()
      setProgressNotice(null)
    }
  }, [resetDraft, selection])

  const applyStatus = useCallback(
    (incoming: SceneGenerationRenderStatusVO): void => {
      if (incoming.projectId !== projectId || incoming.sceneId !== sceneId) return
      const current = statusRef.current
      const merged = mergeRenderStatus(current, incoming)
      const facts = discoveryFactsFor(discoveryFactsRef, scope)
      if (isTerminalState(merged.state)) {
        /* 终态是最终事实：同 scope 同操作的旧发现项与已知阻断立即失效。 */
        statusEpochRef.current += 1
        facts.terminalOperationIds.add(merged.operationId)
        facts.blockers.delete(merged.operationId)
        setUnfinished((record) =>
          record === null || record.scope !== scope
            ? record
            : {
                scope: record.scope,
                value: record.value.filter((item) => item.operationId !== merged.operationId)
              }
        )
      } else if (merged.blocksNewGeneration === true) {
        /*
         * 当前状态本身就是权威发现来源：运行/等待中的阻断在首次发现读回前、
         * 换视图后都保留在列表里；只做本地合并，不为每个进度 tick 查磁盘。
         */
        const known = facts.blockers.get(merged.operationId)
        const next = known ? mergeRenderStatus(known.status, merged) : merged
        facts.blockers.set(merged.operationId, {
          status: next,
          epoch: ++statusEpochRef.current
        })
        setUnfinished((record) => {
          const currentItems = record?.scope === scope ? record.value : []
          const existing = currentItems.find((item) => item.operationId === merged.operationId)
          const nextItem = existing ? mergeRenderStatus(existing, next) : next
          if (existing === nextItem && currentItems[0] === nextItem) return record
          return {
            scope,
            value: [
              nextItem,
              ...currentItems.filter((item) => item.operationId !== merged.operationId)
            ]
          }
        })
      }
      /* 身份先同步失效，再更新状态；正在进行中的迟到响应立即失去写回资格。 */
      const switchedOperation = selection.observe(merged.operationId)
      if (merged === current && current !== null) return
      statusRef.current = merged
      setStatus(merged)
      setProgress((steps) =>
        switchedOperation ? appendProgressStep([], merged) : appendProgressStep(steps, merged)
      )
      if (switchedOperation) {
        resetDraft()
        setProgressNotice(null)
      }
    },
    [projectId, resetDraft, sceneId, scope, selection]
  )

  const applyActionStatus = useCallback(
    (incoming: SceneGenerationRenderStatusVO): void => {
      if (
        incoming.projectId === projectId &&
        incoming.sceneId === sceneId &&
        incoming.operationId !== selection.token().operationId
      ) {
        selection.markExplicitSwitch()
      }
      applyStatus(incoming)
    },
    [applyStatus, projectId, sceneId, selection]
  )

  useEffect(() => {
    if (!projectId || !sceneId) return
    let cancelled = false
    const key = generationScopeKey(projectId, sceneId)
    const discoveryReadId = ++discoveryReadIdRef.current
    const discoveryReadEpoch = statusEpochRef.current
    const token = selection.token()
    const pinnedOperationId = selection.pinnedForCurrentView()
    const stillCurrent = (): boolean => !cancelled && scopeRef.current === key
    void (async () => {
      setLoading(true)
      setLoadError(null)
      setViewCheck({ scope: key, phase: 'checking' })
      let outcome: GenerationViewReloadOutcome = 'error'
      try {
        outcome = await reloadGenerationView({
          client,
          projectId,
          sceneId,
          pinnedOperationId,
          token,
          isAborted: () => !stillCurrent(),
          isSelectionCurrent,
          currentStatus: () => statusRef.current,
          clearPin: () => selection.clearPin(),
          applyStatus,
          clearStatus,
          setUnfinished: (value) => applyDiscovery(key, value, discoveryReadId, discoveryReadEpoch),
          setLoadError: (message, target) =>
            setLoadError(
              message === null
                ? null
                : { scope: key, value: message, ...(target ? { token } : {}) }
            ),
          setUnavailable: (message) =>
            setUnavailable(message === null ? null : { scope: key, value: message }),
          setSelectionNotice: (message) =>
            setSelectionNotice(message === null ? null : { scope: key, value: message })
        })
      } catch (error) {
        if (!stillCurrent()) return
        setLoadError({ scope: key, value: failureOf(error).msg })
      } finally {
        if (stillCurrent()) {
          setLoading(false)
          setViewCheck({ scope: key, phase: outcome === 'error' ? 'failed' : 'ready' })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    applyDiscovery,
    applyStatus,
    clearStatus,
    client,
    isSelectionCurrent,
    projectId,
    reloadNonce,
    sceneId,
    selection
  ])

  const statusCheck: GenerationStatusCheck =
    !projectId || !sceneId
      ? 'ready'
      : viewCheck?.scope === scope
        ? viewCheck.phase
        : 'checking'

  const visibleStatus =
    status && status.projectId === projectId && status.sceneId === sceneId ? status : null
  const visibleUnfinished = unfinished?.scope === scope ? unfinished.value : []
  const visibleLoadError =
    loadError?.scope === scope &&
    (loadError.token === undefined || selection.isCurrent(loadError.token))
      ? loadError.value
      : null
  const unavailableReason = unavailable?.scope === scope ? unavailable.value : null
  const currentToken = selection.token()

  const liveOperationId =
    visibleStatus && !isTerminalState(visibleStatus.state) ? visibleStatus.operationId : null
  const liveThreadId = liveOperationId ? visibleStatus?.threadId : null
  const liveBranchId = liveOperationId ? visibleStatus?.branchId : null

  useEffect(() => {
    if (!liveOperationId || !liveThreadId || !liveBranchId) return
    const token = selection.token()
    return client.subscribeProgress(
      {
        projectId,
        sceneId,
        operationId: liveOperationId,
        threadId: liveThreadId,
        branchId: liveBranchId
      },
      (event) => {
        /* 旧订阅或切走后的迟到事件不能改回旧操作。 */
        if (!selection.isCurrent(token)) return
        setProgressNotice(null)
        applyStatus(event)
      },
      (message) => {
        if (!selection.isCurrent(token)) return
        setProgressNotice({
          scope: generationScopeKey(projectId, sceneId),
          value: { operationId: liveOperationId, message, epoch: token.epoch }
        })
        reload()
      }
    )
  }, [applyStatus, client, liveBranchId, liveOperationId, liveThreadId, projectId, reload, sceneId, selection])

  useLiveStatusReconcile(
    client,
    projectId,
    sceneId,
    liveOperationId,
    selection,
    applyStatus
  )

  const scopedStatus = useCallback((): SceneGenerationRenderStatusVO | null => {
    const current = statusRef.current
    return current && current.projectId === projectId && current.sceneId === sceneId
      ? current
      : null
  }, [projectId, sceneId])

  const selectUnfinished = useCallback(
    (operationId: string): boolean => {
      const selected = unfinishedSelectionOf(visibleUnfinished, operationId, {
        projectId,
        sceneId
      })
      if (!selected) return false
      selection.pin(operationId)
      setSelectionNotice(null)
      applyStatus(selected)
      return true
    },
    [applyStatus, projectId, sceneId, selection, visibleUnfinished]
  )

  return {
    status: visibleStatus,
    loading,
    statusCheck,
    loadError: visibleLoadError,
    unavailableReason,
    unfinished: visibleUnfinished,
    progress,
    scope,
    progressNotice:
      progressNotice?.scope === scope &&
      progressNotice.value.operationId === liveOperationId &&
      progressNotice.value.epoch === currentToken.epoch &&
      liveOperationId !== null
        ? progressNotice.value.message
        : null,
    selectionNotice: selectionNotice?.scope === scope ? selectionNotice.value : null,
    reload,
    refreshDiscovery,
    applyStatus,
    applyActionStatus,
    selectUnfinished,
    scopedStatus,
    scopeRef,
    statusRef,
    selectionToken,
    isSelectionCurrent,
    selectionIntent
  }
}
