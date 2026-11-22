import { useCallback, useEffect, useRef, useState } from 'react'

import type { GenerationHistoryReloadResult } from './useGenerationHistory'

/** 未知分叉的来源身份；scope 与检查点共同隔离不同工程/场景/记录。 */
export type ForkUnknownSource = {
  projectId: string
  sceneId: string
  threadId: string
  branchId: string
  checkpointId: string
}

export type ForkUnknownStatus = 'unknown' | 'checking' | 'rechecked' | 'failed'

export type ForkUnknownEntry = ForkUnknownSource & {
  key: string
  sourceSummary: string
  message: string
  status: ForkUnknownStatus
  failureMessage: string | null
  requestId: number
}

export type DiscoveryRefreshResult =
  | { ok: true }
  | { ok: false; message: string }

export type ForkUnknownCheckTasks = {
  history: () => Promise<GenerationHistoryReloadResult>
  discovery: () => Promise<DiscoveryRefreshResult>
}

export type ForkUnknownController = {
  /** 当前工程/场景的未知项；其它场景的记录不参与显示。 */
  entries: readonly ForkUnknownEntry[]
  find: (source: ForkUnknownSource) => ForkUnknownEntry | null
  markUnknown: (
    source: ForkUnknownSource,
    sourceSummary: string,
    message: string
  ) => void
  acknowledge: (source: ForkUnknownSource) => void
  /** 等待历史和发现都结束后才更新为完成；失败保留未知并可重试。 */
  recheck: (source: ForkUnknownSource, tasks: ForkUnknownCheckTasks) => Promise<void>
}

const checkFailed = '重新读取 AI 历史与待处理发现失败，请重试。'

export function forkUnknownKey(source: ForkUnknownSource): string {
  return JSON.stringify([
    source.projectId,
    source.sceneId,
    source.threadId,
    source.branchId,
    source.checkpointId
  ])
}

async function settleCheck(
  task: () => Promise<DiscoveryRefreshResult | GenerationHistoryReloadResult>
): Promise<DiscoveryRefreshResult> {
  try {
    const result = await task()
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  } catch {
    return { ok: false, message: checkFailed }
  }
}

/**
 * 页面级未知分叉登记。挂在 WorkbenchPage，跨历史标签与抽屉卸载保留；
 * 只保存在当前进程内，不写盘、不做重启迁移。
 */
export function useForkUnknownRegistry({
  projectId,
  sceneId
}: {
  projectId: string
  sceneId: string
}): ForkUnknownController {
  const [records, setRecords] = useState<readonly ForkUnknownEntry[]>([])
  const requestCounter = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const markUnknown = useCallback(
    (source: ForkUnknownSource, sourceSummary: string, message: string): void => {
      const key = forkUnknownKey(source)
      const requestId = ++requestCounter.current
      setRecords((current) => {
        const next: ForkUnknownEntry = {
          ...source,
          key,
          sourceSummary,
          message,
          status: 'unknown',
          failureMessage: null,
          requestId
        }
        const existing = current.find((entry) => entry.key === key)
        return existing === undefined
          ? [...current, next]
          : current.map((entry) => (entry.key === key ? next : entry))
      })
    },
    []
  )

  const acknowledge = useCallback((source: ForkUnknownSource): void => {
    const key = forkUnknownKey(source)
    setRecords((current) => current.filter((entry) => entry.key !== key))
  }, [])

  const recheck = useCallback(
    async (source: ForkUnknownSource, tasks: ForkUnknownCheckTasks): Promise<void> => {
      const key = forkUnknownKey(source)
      const requestId = ++requestCounter.current
      setRecords((current) =>
        current.map((entry) =>
          entry.key === key
            ? { ...entry, status: 'checking', failureMessage: null, requestId }
            : entry
        )
      )
      const [history, discovery] = await Promise.all([
        settleCheck(tasks.history),
        settleCheck(tasks.discovery)
      ])
      if (!mounted.current) return
      const failure = !history.ok
        ? history.message
        : !discovery.ok
          ? discovery.message
          : null
      setRecords((current) =>
        current.map((entry) =>
          entry.key === key && entry.requestId === requestId
            ? {
                ...entry,
                status: failure === null ? 'rechecked' : 'failed',
                failureMessage: failure
              }
            : entry
        )
      )
    },
    []
  )

  const entries = records.filter(
    (entry) => entry.projectId === projectId && entry.sceneId === sceneId
  )
  const find = (source: ForkUnknownSource): ForkUnknownEntry | null =>
    records.find((entry) => entry.key === forkUnknownKey(source)) ?? null

  return { entries, find, markUnknown, acknowledge, recheck }
}
