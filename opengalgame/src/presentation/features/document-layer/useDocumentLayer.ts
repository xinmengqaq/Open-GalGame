import { useCallback, useEffect, useState } from 'react'

import type { ProjectInputSourceVO } from '@application/project-files/vo/ProjectInputSourceVO'
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

/** 只有加载完成且正文非空时，文档层才真正向用户显示了可读内容。 */
export function documentBodyDisplayable(
  view: Pick<DocumentBodyView, 'status' | 'body'>
): boolean {
  return view.status === 'ready' && view.body.trim().length > 0
}

type DocumentRequest = {
  cardId: string
  status: 'loading' | 'failed'
  message: string | null
  reload: boolean
}

type DocumentLoadKey = {
  client: ProjectFilesClient
  cardId: string
  sourceId: string
  attempt: number
  refresh: boolean
  detail: ProjectInputSourceVO | undefined
}

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
  const loadKey: DocumentLoadKey = {
    client,
    cardId: card.cardId,
    sourceId: card.sourceId,
    attempt,
    refresh,
    detail
  }
  const [applied, setApplied] = useState<DocumentLoadKey>(loadKey)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const reload = useCallback(() => {
    setRefresh(true)
    setAttempt((value) => value + 1)
  }, [])

  const needsLoad = detail === undefined || refresh
  if (
    applied.client !== loadKey.client ||
    applied.cardId !== loadKey.cardId ||
    applied.sourceId !== loadKey.sourceId ||
    applied.attempt !== loadKey.attempt ||
    applied.refresh !== loadKey.refresh ||
    applied.detail !== loadKey.detail
  ) {
    setApplied(loadKey)
    if (needsLoad) {
      setRequest({ cardId: card.cardId, status: 'loading', message: null, reload: refresh })
    }
  }

  useEffect(() => {
    if (detail && !refresh) return
    let cancelled = false
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
