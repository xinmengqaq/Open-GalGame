import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  SceneGenerationHistoryDetailVO,
  SceneGenerationHistorySummaryVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { failureOf } from '@presentation/feedback/failure'

const detailReadFailed = '分叉资格暂时没有读出来，请稍后重试。'

export type HistoryDetailController = {
  detail: SceneGenerationHistoryDetailVO | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * 按需读取单条 AI 历史的展示摘要与分叉资格。资格只来自后端检查点读取；
 * 列表边界、候选存在或当前运行状态都不参与判断。记录切换由调用方用检查点键重挂载，
 * 在途结果通过清理函数丢弃。
 */
export function useGenerationHistoryDetail({
  client,
  record
}: {
  client: SceneGenerationClient
  record: SceneGenerationHistorySummaryVO
}): HistoryDetailController {
  const [detail, setDetail] = useState<SceneGenerationHistoryDetailVO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    requestGeneration.current += 1
    const generation = requestGeneration.current
    let cancelled = false
    const stillCurrent = (): boolean => !cancelled && generation === requestGeneration.current
    void (async () => {
      try {
        const result = await client.readCheckpoint({
          projectId: record.projectId,
          sceneId: record.sceneId,
          threadId: record.threadId,
          branchId: record.branchId,
          checkpointId: record.checkpointId
        })
        if (!stillCurrent()) return
        if (result.code !== ErrorCodes.success || !result.data) {
          setError(result.msg || detailReadFailed)
          return
        }
        setDetail(result.data)
      } catch (failure) {
        if (!stillCurrent()) return
        setError(failureOf(failure).msg || detailReadFailed)
      } finally {
        if (stillCurrent()) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, record, reloadNonce])

  const reload = useCallback((): void => {
    setDetail(null)
    setLoading(true)
    setError(null)
    setReloadNonce((nonce) => nonce + 1)
  }, [])

  return { detail, loading, error, reload }
}
