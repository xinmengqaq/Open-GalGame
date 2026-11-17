import { useCallback, useEffect, useRef, useState } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { failureOf } from '@presentation/feedback/failure'

import {
  appendProgressStep,
  isTerminalState,
  mergeRenderStatus,
  type GenerationActionKind,
  type GenerationProgressStep
} from './generationPresentation'
import type { MutableRef } from './useGenerationDraft'

type Scoped<T> = { scope: string; value: T }

type ProgressNotice = { operationId: string; message: string }

/**
 * 打开抽屉时只读历史和状态，不核对工作区。历史为空时再读最近一次执行：
 * 运行中的操作可能还没有检查点，不会出现在历史摘要里，但必须仍能恢复状态。
 */
export async function readGenerationHistory(
  client: Pick<SceneGenerationClient, 'listHistory' | 'status' | 'latest'>,
  projectId: string,
  sceneId: string
): Promise<
  | { kind: 'empty' }
  | { kind: 'status'; status: SceneGenerationRenderStatusVO }
  | { kind: 'error'; message: string; forbidden: boolean }
> {
  const history = await client.listHistory({ projectId, sceneId, limit: 1 })
  if (history.code !== ErrorCodes.success) {
    return {
      kind: 'error',
      message: history.msg,
      forbidden: history.code === ErrorCodes.forbidden
    }
  }
  const latest = history.data?.[0]
  if (!latest) {
    const recent = await client.latest({ projectId, sceneId })
    /* 最近一次读取失败仍按空处理：历史已成功读空是当前权威事实，不用回退查询覆盖它。 */
    if (recent.code !== ErrorCodes.success) return { kind: 'empty' }
    if (!recent.data) return { kind: 'empty' }
    return { kind: 'status', status: recent.data }
  }
  const result = await client.status({ projectId, sceneId, operationId: latest.operationId })
  if (result.code !== ErrorCodes.success || !result.data) {
    return { kind: 'error', message: result.msg, forbidden: false }
  }
  return { kind: 'status', status: result.data }
}

const statusReconcileMs = 4_000

/** 进度事件可能丢失；活动操作按状态查询收敛，不能把“提交中”留到整页重载。 */
function useLiveStatusReconcile(
  client: SceneGenerationClient,
  projectId: string,
  sceneId: string,
  liveOperationId: string | null,
  applyStatus: (status: SceneGenerationRenderStatusVO) => void
): void {
  useEffect(() => {
    if (!liveOperationId) return
    let cancelled = false
    let timer: number | null = null
    const reconcile = async (): Promise<void> => {
      const result = await client.status({ projectId, sceneId, operationId: liveOperationId })
      if (cancelled) return
      if (result.code === ErrorCodes.success && result.data) {
        applyStatus(result.data)
        if (isTerminalState(result.data.state)) return
      }
      timer = window.setTimeout(() => {
        void reconcile()
      }, statusReconcileMs)
    }
    void reconcile()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [applyStatus, client, liveOperationId, projectId, sceneId])
}

interface UseGenerationStatusOptions {
  readonly client: SceneGenerationClient
  readonly projectId: string
  readonly sceneId: string
  readonly statusRef: MutableRef<SceneGenerationRenderStatusVO | null>
  readonly pendingRef: MutableRef<GenerationActionKind | null>
  readonly resetDraft: () => void
}

export interface UseGenerationStatusResult {
  readonly status: SceneGenerationRenderStatusVO | null
  readonly loading: boolean
  readonly loadError: string | null
  readonly unavailableReason: string | null
  readonly progress: readonly GenerationProgressStep[]
  readonly progressNotice: string | null
  readonly reload: () => void
  readonly applyStatus: (incoming: SceneGenerationRenderStatusVO) => void
  readonly scopedStatus: () => SceneGenerationRenderStatusVO | null
  readonly scope: string
  readonly scopeRef: MutableRef<string>
  readonly statusRef: MutableRef<SceneGenerationRenderStatusVO | null>
}

/**
 * 当前生成状态、历史、进度订阅与 4s 收敛的唯一所有者。
 * 关闭抽屉不取消任务；状态和订阅随页面身份存活，reload 只重新核对后端事实。
 */
export function useGenerationStatus({
  client,
  projectId,
  sceneId,
  statusRef,
  pendingRef,
  resetDraft
}: UseGenerationStatusOptions): UseGenerationStatusResult {
  const [status, setStatus] = useState<SceneGenerationRenderStatusVO | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<Scoped<string> | null>(null)
  const [unavailable, setUnavailable] = useState<Scoped<string> | null>(null)
  const [progress, setProgress] = useState<readonly GenerationProgressStep[]>([])
  const [progressNotice, setProgressNotice] = useState<Scoped<ProgressNotice> | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const scope = `${projectId}|${sceneId}`
  const scopeRef = useRef(scope)

  useEffect(() => {
    scopeRef.current = scope
  }, [scope])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const reload = useCallback((): void => {
    if (pendingRef.current !== null) return
    setReloadNonce((count) => count + 1)
  }, [])

  const applyStatus = useCallback(
    (incoming: SceneGenerationRenderStatusVO): void => {
      if (incoming.projectId !== projectId || incoming.sceneId !== sceneId) return
      const current = statusRef.current
      const merged = mergeRenderStatus(current, incoming)
      if (merged === current && current !== null) return
      const switchedOperation = current === null || current.operationId !== merged.operationId
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
    [projectId, resetDraft, sceneId]
  )

  useEffect(() => {
    if (!projectId || !sceneId) return
    let cancelled = false
    const key = `${projectId}|${sceneId}`
    const stillCurrent = (): boolean => !cancelled && scopeRef.current === key
    void (async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const history = await readGenerationHistory(client, projectId, sceneId)
        if (!stillCurrent()) return
        if (history.kind === 'error') {
          setLoadError({ scope: key, value: history.message })
          if (history.forbidden) setUnavailable({ scope: key, value: history.message })
          return
        }
        setUnavailable(null)
        if (history.kind === 'empty') {
          const current = statusRef.current
          if (current === null || isTerminalState(current.state)) {
            statusRef.current = null
            setStatus(null)
            setProgress([])
          }
          return
        }
        // 重新挂载或重新核对时，最新历史就是页面唯一事实，交给统一投影渲染。
        applyStatus(history.status)
        setLoadError(null)
      } catch (error) {
        if (!stillCurrent()) return
        setLoadError({ scope: key, value: failureOf(error).msg })
      } finally {
        if (stillCurrent()) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyStatus, client, projectId, reloadNonce, sceneId])

  const visibleStatus =
    status && status.projectId === projectId && status.sceneId === sceneId ? status : null
  const visibleLoadError = loadError?.scope === scope ? loadError.value : null
  const unavailableReason = unavailable?.scope === scope ? unavailable.value : null

  const liveOperationId =
    visibleStatus && !isTerminalState(visibleStatus.state) ? visibleStatus.operationId : null
  const liveThreadId = liveOperationId ? visibleStatus?.threadId : null
  const liveBranchId = liveOperationId ? visibleStatus?.branchId : null

  useEffect(() => {
    if (!liveOperationId || !liveThreadId || !liveBranchId) return
    return client.subscribeProgress(
      {
        projectId,
        sceneId,
        operationId: liveOperationId,
        threadId: liveThreadId,
        branchId: liveBranchId
      },
      (event) => {
        setProgressNotice(null)
        applyStatus(event)
      },
      (message) => {
        setProgressNotice({
          scope: `${projectId}|${sceneId}`,
          value: { operationId: liveOperationId, message }
        })
        reload()
      }
    )
  }, [applyStatus, client, liveBranchId, liveOperationId, liveThreadId, projectId, reload, sceneId])

  useLiveStatusReconcile(client, projectId, sceneId, liveOperationId, applyStatus)

  const scopedStatus = useCallback((): SceneGenerationRenderStatusVO | null => {
    const current = statusRef.current
    return current && current.projectId === projectId && current.sceneId === sceneId
      ? current
      : null
  }, [projectId, sceneId])

  return {
    status: visibleStatus,
    loading,
    loadError: visibleLoadError,
    unavailableReason,
    progress,
    scope,
    progressNotice:
      progressNotice?.scope === scope &&
      progressNotice.value.operationId === liveOperationId &&
      liveOperationId !== null
        ? progressNotice.value.message
        : null,
    reload,
    applyStatus,
    scopedStatus,
    scopeRef,
    statusRef
  }
}
