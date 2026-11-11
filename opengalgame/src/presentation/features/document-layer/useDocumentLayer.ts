import { useCallback, useEffect, useState } from 'react'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionDocumentCard } from '../workbench-session/workbenchSession.types'
import { useShallow } from 'zustand/react/shallow'

export type DocumentBodyStatus = 'loading' | 'ready' | 'empty' | 'failed'

export type DocumentBodyView = {
  status: DocumentBodyStatus
  body: string
  message: string | null
  retry: () => void
  reload: () => void
}

type DocumentRequest = {
  cardId: string
  status: 'loading' | 'failed'
  message: string | null
  reload: boolean
}

/**
 * 文档正文只从工程来源读取。已有详情直接使用，否则按当前卡片重新读取。
 * `reload` 在已有详情时也强制重读，用于保存冲突后取最新正文。
 */
export function useDocumentBody(
  client: ProjectFilesClient,
  card: SessionDocumentCard
): DocumentBodyView {
  const source = useWorkbenchSessionStore(
    useShallow((state) => sourceFactsOf(state, card.sourceId))
  )
  const detail = source.detail?.contentKind === 'text' ? source.detail : undefined
  const [attempt, setAttempt] = useState(0)
  const [refresh, setRefresh] = useState(false)
  const [request, setRequest] = useState<DocumentRequest>({
    cardId: card.cardId,
    status: 'loading',
    message: null,
    reload: false
  })
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const reload = useCallback(() => {
    setRefresh(true)
    setAttempt((value) => value + 1)
  }, [])

  useEffect(() => {
    if (detail && !refresh) return
    let cancelled = false
    setRequest({ cardId: card.cardId, status: 'loading', message: null, reload: refresh })
    const load = async (): Promise<void> => {
      const state = useWorkbenchSessionStore.getState()
      try {
        const snapshot = requireSuccess(
          await client.readProjectInputSources({
            projectId: state.projectId,
            sourceIds: [card.sourceId]
          })
        )
        if (cancelled) return
        setRefresh(false)
        useWorkbenchSessionStore.getState().putSourceDetails(snapshot.sources)
        const next = snapshot.sources.find((item) => item.sourceId === card.sourceId)
        if (next?.contentKind !== 'text') {
          setRequest({
            cardId: card.cardId,
            status: 'failed',
            message: '这个来源没有可读取的文档正文。',
            reload: refresh
          })
        }
      } catch (error) {
        if (cancelled) return
        setRequest({
          cardId: card.cardId,
          status: 'failed',
          message: failureOf(error).msg || '请稍后重试。',
          reload: refresh
        })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [attempt, card.cardId, card.sourceId, client, detail, refresh])

  const reloadFailed =
    request.cardId === card.cardId && request.reload && request.status === 'failed'
  if (reloadFailed) {
    return { status: 'failed', body: '', message: request.message, retry, reload }
  }
  if (detail) {
    const body = detail.body
    return {
      status: body.trim().length > 0 ? 'ready' : 'empty',
      body,
      message: null,
      retry,
      reload
    }
  }
  if (request.cardId === card.cardId && request.status === 'failed') {
    return { status: 'failed', body: '', message: request.message, retry, reload }
  }
  return { status: 'loading', body: '', message: null, retry, reload }
}
