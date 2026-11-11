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
  /**
   * 在同一候选会话里重建舞台画面；不重开候选、不重读内容，也不改变只读身份。
   * 浏览器只在真实点击后允许播放声音，重新载入可回到标题页再点“开始游戏”。
   */
  readonly reloadStage: () => void
  /** 关闭旧会话后按同一目标重新打开；失效、过期和打开失败都用它。 */
  readonly reopen: () => void
  /** 同一会话重读；会话已被拒绝时自动转为重新打开。 */
  readonly retryRead: () => void
}

/** 同一候选首次显示才打开；切走保留锁存，候选变化或清空时解除。 */
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

/**
 * 打开判定。重新打开必须先把锁存当作空值，再让同一目标重新通过 activation；
 * 否则同一候选会被判为“已经打开过”而不再发请求。
 */
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

/**
 * 候选预览状态机接线。打开和关闭走生成客户端，读取与舞台事件走预览客户端。
 * 每次候选切换都先清空旧舞台、关闭旧会话，再打开新候选；晚到结果按会话和代次丢弃。
 */
export function useCandidatePreview(options: {
  readonly generationClient: CandidateGenerationClient
  readonly previewClient: CandidateReadClient | null
  readonly target: CandidatePreviewTarget | null
  /** 候选标签是否正在显示。未激活前不打开会话。 */
  readonly active?: boolean
}): CandidatePreviewController {
  const { generationClient, previewClient, target, active = true } = options
  const [state, dispatch] = useReducer(candidatePreviewReducer, initialCandidatePreviewState)
  const [reopenNonce, setReopenNonce] = useState(0)
  const sessionRef = useRef<ActiveSession | null>(null)
  const generationRef = useRef(0)
  const readTokenRef = useRef(0)
  const targetKey = target ? candidatePreviewTargetKey(target) : ''
  const targetRef = useRef(target)
  const openedTargetRef = useRef('')
  const reopenRequestedRef = useRef(false)
  const phase = candidatePreviewPhaseOf(state)

  // 目标身份用键驱动重开；这里只保存最新对象，避免同键新对象触发关闭重开。
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
      // 有真实候选但当前环境没有预览桥：保留节点并明确不支持，不打开假舞台。
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
        // 标签已关闭或候选已切换：用当次原始范围关闭晚到的会话，失败交由 TTL 兜底。
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
      // 打开响应必须落在请求的候选上；不一致时关闭该会话，不把别的候选拼进当前审阅。
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
      // 先建立监听：打开返回后、订阅前到达的就绪或失效由客户端补投，不丢 ready 竞态。
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

  // 打开请求或画面就绪超过冻结的 15 秒还停在 opening 时，只标记“仍在启动”，
  // 让界面给出重新打开；不判定失败、不取消会话，也不伪造 ready。重新打开会重置计时。
  useEffect(() => {
    if (phase !== 'opening' || state.openingStalled) return
    const timer = window.setTimeout(
      () => dispatch({ type: 'opening-stalled' }),
      candidateOpeningStallMs
    )
    return () => window.clearTimeout(timer)
  }, [phase, state.candidateSnapshotId, state.openingStalled])

  // 运行会话到期只卸载游戏画面并保留候选依据；重新运行会创建新的运行会话。
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

  // 失效或过期后会话已由后端释放，不再发无意义的关闭请求。
  useEffect(() => {
    if (state.lifecycle !== 'expired' && state.lifecycle !== 'invalidated') return
    if (sessionRef.current?.sessionId === state.sessionId) sessionRef.current = null
  }, [state.lifecycle, state.sessionId])

  const reloadStage = useCallback((): void => {
    dispatch({ type: 'reload-stage' })
  }, [])

  const reopen = useCallback((): void => {
    if (phase === null) return
    // 标记本次为重新打开；effect 会按“清掉打开锁存”的语义重新判定同一目标，
    // 否则非 new target 的打开请求会被 activation 判为“已经打开过”而不再发出。
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
