import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import type { SceneGenerationCandidatePreviewVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { subscribeCandidateStage } from '@presentation/features/game-stage/gameStageEvents'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import {
  candidateOpeningStallMs,
  candidatePreviewPhaseOf,
  candidatePreviewReducer,
  candidatePreviewTargetKey,
  initialCandidatePreviewState,
  isCandidateSessionRejection,
  type CandidatePreviewPhase,
  type CandidatePreviewState,
  type CandidatePreviewTarget
} from './candidatePreviewState'

type CandidateGenerationClient = Pick<SceneGenerationClient, 'openPreview' | 'closePreview'>

type CandidateReadClient = Pick<
  ScenePreviewClient,
  'readCandidatePreview' | 'subscribeCandidatePreview'
>

type ActiveSession = {
  readonly sessionId: string
  readonly projectId: string
  readonly sceneId: string
  readonly candidateSnapshotId: string
  readonly operationId: string
  readonly generation: number
}

export type CandidatePreviewController = {
  readonly state: CandidatePreviewState
  readonly phase: CandidatePreviewPhase | null
  readonly reloadStage: () => void
  readonly reopen: () => void
  readonly retryRead: () => void
}

export function candidatePreviewActivation(
  openedTarget: string,
  targetKey: string,
  active: boolean
): { readonly openedTarget: string; readonly open: boolean } {
  if (!targetKey) return { openedTarget: '', open: false }
  if (openedTarget === targetKey) return { openedTarget, open: false }
  if (!active) return { openedTarget: '', open: false }
  return { openedTarget: targetKey, open: true }
}

export function candidatePreviewOpenDecision(
  openedTarget: string,
  targetKey: string,
  active: boolean,
  reopening: boolean
): { readonly openedTarget: string; readonly open: boolean } {
  return candidatePreviewActivation(reopening ? '' : openedTarget, targetKey, active)
}

function closeSession(client: CandidateGenerationClient, session: ActiveSession): void {
  void client
    .closePreview({
      projectId: session.projectId,
      sceneId: session.sceneId,
      operationId: session.operationId,
      previewSessionId: session.sessionId
    })
    .catch(() => undefined)
}

export function useCandidatePreview(options: {
  readonly generationClient: CandidateGenerationClient
  readonly previewClient: CandidateReadClient | null
  readonly target: CandidatePreviewTarget | null
  readonly active?: boolean
  /** 候选预览会话真正打开后调用；打开失败不调用。 */
  readonly onOpened?: (candidateSnapshotId: string) => void
  /** 离开候选视图或组件卸载导致预览会话关闭时调用；换候选不发。 */
  readonly onReturned?: (candidateSnapshotId: string) => void
}): CandidatePreviewController {
  const { generationClient, previewClient, target, active = true } = options
  const onOpenedRef = useRef(options.onOpened)
  const onReturnedRef = useRef(options.onReturned)
  useEffect(() => {
    onOpenedRef.current = options.onOpened
    onReturnedRef.current = options.onReturned
  }, [options.onOpened, options.onReturned])
  const [state, dispatch] = useReducer(candidatePreviewReducer, initialCandidatePreviewState)
  const [reopenNonce, setReopenNonce] = useState(0)
  const sessionRef = useRef<ActiveSession | null>(null)
  const generationRef = useRef(0)
  const readTokenRef = useRef(0)
  const targetKey = target ? candidatePreviewTargetKey(target) : ''
  const targetRef = useRef(target)
  const openedTargetRef = useRef('')
  const reopenRequestedRef = useRef(false)
  const openedCandidateRef = useRef<string | null>(null)
  const phase = candidatePreviewPhaseOf(state)

  useEffect(() => {
    targetRef.current = target
  }, [target])

  const readFromSession = useCallback(
    async (
      client: CandidateReadClient,
      session: ActiveSession,
      isCurrent: () => boolean
    ): Promise<void> => {
      const token = ++readTokenRef.current
      dispatch({ type: 'read-started' })
      let result: AjaxResult<CandidatePreviewVO> | null = null
      try {
        result = await client.readCandidatePreview({
          projectId: session.projectId,
          sceneId: session.sceneId,
          previewSessionId: session.sessionId
        })
      } catch {
        result = null
      }
      if (
        token !== readTokenRef.current ||
        !isCurrent() ||
        sessionRef.current?.sessionId !== session.sessionId
      )
        return
      if (result?.code === ErrorCodes.success && result.data) {
        dispatch({ type: 'read-succeeded', preview: result.data })
        return
      }
      dispatch({
        type: 'read-failed',
        message: result?.msg || '游戏候选读取失败',
        sessionRejected: isCandidateSessionRejection(result?.code ?? ErrorCodes.communicationFailed)
      })
    },
    []
  )

  useEffect(() => {
    const activeTarget = targetRef.current
    const reopening = reopenRequestedRef.current
    reopenRequestedRef.current = false
    const activation = candidatePreviewOpenDecision(
      openedTargetRef.current,
      targetKey,
      active,
      reopening
    )
    openedTargetRef.current = activation.openedTarget
    if (!activation.open) {
      if (!activeTarget || openedTargetRef.current !== targetKey) dispatch({ type: 'reset' })
      return () => undefined
    }
    const generation = ++generationRef.current
    readTokenRef.current += 1
    if (!activeTarget) return () => undefined
    if (!previewClient) {
      dispatch({
        type: 'start',
        projectId: activeTarget.projectId,
        sceneId: activeTarget.sceneId,
        candidateSnapshotId: activeTarget.candidateSnapshotId
      })
      dispatch({
        type: 'open-failed',
        unsupported: true,
        message: '当前环境不支持场景预览'
      })
      return () => undefined
    }
    let disposed = false
    let stop: (() => void) | null = null
    const isCurrent = (): boolean => !disposed && generationRef.current === generation
    dispatch({
      type: 'start',
      projectId: activeTarget.projectId,
      sceneId: activeTarget.sceneId,
      candidateSnapshotId: activeTarget.candidateSnapshotId
    })

    void (async () => {
      let opened: AjaxResult<SceneGenerationCandidatePreviewVO> | null = null
      try {
        opened = await generationClient.openPreview({ ...activeTarget })
      } catch {
        opened = null
      }
      if (!isCurrent()) {
        if (opened?.code === ErrorCodes.success && opened.data) {
          closeSession(generationClient, {
            sessionId: opened.data.previewSessionId,
            projectId: activeTarget.projectId,
            sceneId: activeTarget.sceneId,
            candidateSnapshotId: opened.data.candidateSnapshotId,
            operationId: activeTarget.operationId,
            generation
          })
        }
        return
      }
      if (!opened || opened.code !== ErrorCodes.success || !opened.data) {
        dispatch({
          type: 'open-failed',
          unsupported: false,
          message: opened?.msg || '游戏候选暂时打不开'
        })
        return
      }
      const session: ActiveSession = {
        sessionId: opened.data.previewSessionId,
        projectId: activeTarget.projectId,
        sceneId: activeTarget.sceneId,
        candidateSnapshotId: opened.data.candidateSnapshotId,
        operationId: activeTarget.operationId,
        generation
      }
      if (opened.data.candidateSnapshotId !== activeTarget.candidateSnapshotId) {
        closeSession(generationClient, session)
        dispatch({
          type: 'open-failed',
          unsupported: false,
          message: '候选预览与当前审阅不一致'
        })
        return
      }
      sessionRef.current = session
      const expiresAt = Date.parse(opened.data.expiresAt)
      dispatch({
        type: 'opened',
        projectId: activeTarget.projectId,
        sceneId: activeTarget.sceneId,
        sessionId: session.sessionId,
        candidateSnapshotId: opened.data.candidateSnapshotId,
        stageUrl: opened.data.url,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
      })
      openedCandidateRef.current = opened.data.candidateSnapshotId
      try {
        onOpenedRef.current?.(opened.data.candidateSnapshotId)
      } catch {
        // 指引观察者异常不能打断候选预览。
      }
      stop = subscribeCandidateStage(
        previewClient,
        {
          projectId: activeTarget.projectId,
          sceneId: activeTarget.sceneId,
          previewSessionId: session.sessionId
        },
        {
          projectId: session.projectId,
          sceneId: session.sceneId,
          previewSessionId: session.sessionId,
          candidateSnapshotId: session.candidateSnapshotId
        },
        (event) => {
          if (isCurrent()) dispatch({ type: 'event', event })
        }
      )
      await readFromSession(previewClient, session, isCurrent)
    })()

    return () => {
      disposed = true
      readTokenRef.current += 1
      stop?.()
      const session = sessionRef.current
      if (session && session.generation === generation) {
        sessionRef.current = null
        closeSession(generationClient, session)
      }
    }
  }, [active, generationClient, previewClient, readFromSession, reopenNonce, targetKey])

  useEffect(() => {
    if (active) return
    const opened = openedCandidateRef.current
    if (!opened) return
    openedCandidateRef.current = null
    try {
      onReturnedRef.current?.(opened)
    } catch {
      // 指引观察者异常不能改变离开候选视图的行为。
    }
  }, [active])

  useEffect(() => {
    // 被新候选替换不是“返回”，旧候选的返回事实不应补发。
    openedCandidateRef.current = null
  }, [targetKey])

  useEffect(
    () => () => {
      const opened = openedCandidateRef.current
      if (!opened) return
      openedCandidateRef.current = null
      try {
        onReturnedRef.current?.(opened)
      } catch {
        // 指引观察者异常不能改变抽屉关闭行为。
      }
    },
    []
  )

  useEffect(() => {
    if (phase !== 'opening' || state.openingStalled) return
    const timer = window.setTimeout(
      () => dispatch({ type: 'opening-stalled' }),
      candidateOpeningStallMs
    )
    return () => window.clearTimeout(timer)
  }, [phase, state.candidateSnapshotId, state.openingStalled])

  useEffect(() => {
    if (state.lifecycle !== 'open' || state.expiresAt === null) return
    const delay = state.expiresAt - Date.now()
    if (delay <= 0) {
      dispatch({ type: 'expire' })
      return
    }
    const timer = window.setTimeout(
      () => dispatch({ type: 'expire' }),
      Math.min(delay, 2_147_483_647)
    )
    return () => window.clearTimeout(timer)
  }, [state.expiresAt, state.lifecycle])

  useEffect(() => {
    if (state.lifecycle !== 'expired' && state.lifecycle !== 'invalidated') return
    if (sessionRef.current?.sessionId === state.sessionId) sessionRef.current = null
  }, [state.lifecycle, state.sessionId])

  const reloadStage = useCallback((): void => {
    dispatch({ type: 'reload-stage' })
  }, [])

  const reopen = useCallback((): void => {
    if (phase === null) return
    reopenRequestedRef.current = true
    setReopenNonce((count) => count + 1)
  }, [phase])

  const retryRead = useCallback((): void => {
    const session = sessionRef.current
    if (
      previewClient &&
      session &&
      (phase === 'read-failed' || phase === 'ready' || phase === 'stage-failed')
    ) {
      void readFromSession(previewClient, session, () => true)
      return
    }
    if (phase !== null && phase !== 'opening' && phase !== 'unsupported') reopen()
  }, [phase, previewClient, readFromSession, reopen])

  return { state, phase, reloadStage, reopen, retryRead }
}
