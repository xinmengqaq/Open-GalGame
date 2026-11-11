import { useCallback, useEffect, useRef, useState } from 'react'

import type { SceneGenerationReplyDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { failureOf, requireSuccess } from '@presentation/feedback/failure'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '@presentation/feedback/workbenchFeedback'
import { promptReferenceFailureOf } from '@presentation/features/workbench-session/promptReferences'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  appendProgressStep,
  buildPrimaryReply,
  canAccept,
  canDiscard,
  effectiveDraft,
  emptyDraft,
  generationConfirmedControls,
  generationPhaseOf,
  generationPolicy,
  isTerminalState,
  mergeRenderStatus,
  resumeRequestOf,
  retryRepairRequestOf,
  startBlockedReason,
  type GenerationActionFailure,
  type GenerationActionKind,
  type GenerationDraft,
  type GenerationPhase,
  type GenerationProgressStep,
  type StartBlockerInput
} from './generationPresentation'

export type SaveCanvasOutcome = { ok: true } | { ok: false; message: string }

type UseSceneGenerationOptions = {
  projectClient: ProjectClient
  client: SceneGenerationClient
  projectId: string
  sceneId: string
  canvasId: string
  saveState: WorkbenchSaveState
  pageBlocked: boolean
  canvasReady: boolean
  saveCanvas: () => Promise<SaveCanvasOutcome>
}

export type SceneGenerationController = {
  status: SceneGenerationRenderStatusVO | null
  phase: GenerationPhase
  loading: boolean
  loadError: string | null
  unavailableReason: string | null
  pending: GenerationActionKind | null
  startPhase: 'saving' | 'preparing' | null
  actionError: GenerationActionFailure | null
  draft: GenerationDraft
  progress: readonly GenerationProgressStep[]
  /** 进度订阅失败等非阻断提示；不表示生成失败。 */
  progressNotice: string | null
  startBlockedReason: string | null
  start: () => Promise<void>
  submitPrimary: () => Promise<void>
  accept: () => Promise<void>
  discard: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  cancel: () => Promise<void>
  /** 非中断修复失败：携带已确认修改正文和上一候选来源发起新操作。 */
  retryRepair: () => Promise<void>
  selectOption: (optionId: string | null) => void
  selectAnswer: (questionId: string, optionId: string | null) => void
  setAnswerBody: (questionId: string, body: string) => void
  setBody: (body: string) => void
  reload: () => void
}

type Scoped<T> = { scope: string; value: T }

type ProgressNotice = { operationId: string; message: string }

function createReplyId(): string {
  const random = globalThis.crypto?.randomUUID
  if (typeof random === 'function') return random.call(globalThis.crypto)
  return `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const WORKSPACE_NOT_READY_GENERATION_MESSAGE = '工程初始化未完成，请重新构建'

/**
 * 生成前引用校验失败只落到提示词卡一次。4101 是通用请求码，
 * 只有文案指向引用且画布确有引用时才显示，避免误导其他无效请求。
 */
function reportPromptReferenceFailure(code: number, message: string): void {
  const referenceFailure = promptReferenceFailureOf({ code, message })
  if (!referenceFailure) return
  const state = useWorkbenchSessionStore.getState()
  const hasReferences = state.cards.some(
    (card) => card.kind === 'prompt' && (card.references?.length ?? 0) > 0
  )
  if (!hasReferences) return
  state.setPromptReferenceAlert({ message: referenceFailure.text })
}

/** 启动前核对工作区。1309 只返回安全文案，不保存、不启动。 */
export async function prepareGenerationWorkspace(
  projectClient: ProjectClient,
  projectId: string
): Promise<{ ok: true } | { ok: false; message: string; workspaceNotReady: boolean }> {
  try {
    requireSuccess(await projectClient.ensureProjectWorkspace({ projectId }))
    return { ok: true }
  } catch (error) {
    const failure = failureOf(error)
    const workspaceNotReady = failure.code === PROJECT_WORKSPACE_NOT_READY_CODE
    return {
      ok: false,
      message: workspaceNotReady ? WORKSPACE_NOT_READY_GENERATION_MESSAGE : failure.msg,
      workspaceNotReady
    }
  }
}

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

/**
 * 场景生成的页面级状态机。抽屉只消费这里的状态和动作；关闭抽屉不触发取消，
 * 订阅与任务状态随页面身份存活，重新打开通过 `reload` 重新核对后端事实。
 */
export function useSceneGeneration(options: UseSceneGenerationOptions): SceneGenerationController {
  const {
    projectClient,
    client,
    projectId,
    sceneId,
    canvasId,
    saveState,
    pageBlocked,
    canvasReady,
    saveCanvas
  } = options

  const [status, setStatus] = useState<SceneGenerationRenderStatusVO | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<Scoped<string> | null>(null)
  const [unavailable, setUnavailable] = useState<Scoped<string> | null>(null)
  const [pending, setPending] = useState<GenerationActionKind | null>(null)
  const [startPhase, setStartPhase] = useState<'saving' | 'preparing' | null>(null)
  const [actionError, setActionError] = useState<Scoped<GenerationActionFailure> | null>(null)
  const [draftState, setDraftState] = useState<GenerationDraft>(emptyDraft)
  const [progress, setProgress] = useState<readonly GenerationProgressStep[]>([])
  const [progressNotice, setProgressNotice] = useState<Scoped<ProgressNotice> | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const scope = `${projectId}|${sceneId}`
  const scopeRef = useRef(scope)
  const statusRef = useRef<SceneGenerationRenderStatusVO | null>(null)
  const pendingRef = useRef<GenerationActionKind | null>(null)

  useEffect(() => {
    scopeRef.current = scope
  }, [scope])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

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
        setDraftState(emptyDraft)
        setProgressNotice(null)
      }
    },
    [projectId, sceneId]
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
  const visibleActionError = actionError?.scope === scope ? actionError.value : null

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

  const blockerInput: StartBlockerInput = {
    saveState,
    pageBlocked,
    canvasReady,
    active: visibleStatus !== null && !isTerminalState(visibleStatus.state),
    unavailableReason
  }
  const blockedReason = startBlockedReason(blockerInput)

  const runAction = useCallback(
    async (
      kind: GenerationActionKind,
      request: () => Promise<{ code: number; msg: string; data?: SceneGenerationRenderStatusVO }>
    ): Promise<void> => {
      if (pendingRef.current !== null) return
      pendingRef.current = kind
      setPending(kind)
      setActionError(null)
      try {
        const result = await request()
        if (result.code !== ErrorCodes.success || !result.data) {
          setActionError({
            scope: scopeRef.current,
            value: {
              kind,
              message: result.msg,
              unverified: result.code === ErrorCodes.communicationFailed,
              code: result.code
            }
          })
          return
        }
        applyStatus(result.data)
      } catch (error) {
        const failure = failureOf(error)
        setActionError({
          scope: scopeRef.current,
          value: { kind, message: failure.msg, unverified: false, code: failure.code }
        })
      } finally {
        pendingRef.current = null
        setPending(null)
        setStartPhase(null)
      }
    },
    [applyStatus]
  )

  const start = useCallback(async (): Promise<void> => {
    if (pendingRef.current !== null) return
    const active = scopedStatus()
    if (active !== null && !isTerminalState(active.state)) return
    if (blockedReason !== null) {
      setActionError({
        scope: scopeRef.current,
        value: { kind: 'start', message: blockedReason, unverified: false }
      })
      return
    }
    if (!projectId || !sceneId || !canvasId) return
    pendingRef.current = 'start'
    setPending('start')
    setActionError(null)
    setStartPhase('saving')
    useWorkbenchSessionStore.getState().setPromptReferenceAlert(null)
    try {
      const prepared = await prepareGenerationWorkspace(projectClient, projectId)
      if (!prepared.ok) {
        setActionError({
          scope: scopeRef.current,
          value: {
            kind: 'start',
            message: prepared.message,
            unverified: false,
            workspaceNotReady: prepared.workspaceNotReady
          }
        })
        return
      }
      const saved = await saveCanvas()
      if (!saved.ok) {
        setActionError({
          scope: scopeRef.current,
          value: { kind: 'start', message: saved.message, unverified: false }
        })
        return
      }
      setStartPhase('preparing')
      const result = await client.start({
        projectId,
        sceneId,
        canvasId,
        confirmedControls: generationConfirmedControls,
        policy: generationPolicy
      })
      if (result.code !== ErrorCodes.success || !result.data) {
        reportPromptReferenceFailure(result.code, result.msg)
        const referenceFailure = promptReferenceFailureOf({
          code: result.code,
          message: result.msg
        })
        setActionError({
          scope: scopeRef.current,
          value: {
            kind: 'start',
            message: referenceFailure?.text ?? result.msg,
            unverified: result.code === ErrorCodes.communicationFailed,
            code: result.code
          }
        })
        return
      }
      useWorkbenchSessionStore.getState().setPromptReferenceAlert(null)
      applyStatus(result.data)
    } catch (error) {
      const failure = failureOf(error)
      reportPromptReferenceFailure(failure.code, failure.msg)
      const referenceFailure = promptReferenceFailureOf(failure)
      setActionError({
        scope: scopeRef.current,
        value: {
          kind: 'start',
          message: referenceFailure?.text ?? failure.msg,
          unverified: false,
          code: failure.code
        }
      })
    } finally {
      pendingRef.current = null
      setPending(null)
      setStartPhase(null)
    }
  }, [
    applyStatus,
    blockedReason,
    canvasId,
    client,
    projectClient,
    projectId,
    saveCanvas,
    sceneId,
    scopedStatus
  ])

  const submitReply = useCallback(
    async (reply: SceneGenerationReplyDTO | null): Promise<void> => {
      const current = scopedStatus()
      const interaction = current?.interaction
      if (!current || !interaction || reply === null || pendingRef.current !== null) return
      await runAction('reply', () =>
        client.reply({
          projectId: current.projectId,
          sceneId: current.sceneId,
          operationId: current.operationId,
          threadId: current.threadId,
          branchId: current.branchId,
          interactionId: interaction.interactionId,
          checkpointId: interaction.checkpointId,
          ...(interaction.candidateSnapshotId
            ? { candidateSnapshotId: interaction.candidateSnapshotId }
            : {}),
          replyId: createReplyId(),
          reply
        })
      )
    },
    [client, runAction, scopedStatus]
  )

  const currentInteraction: SceneGenerationRenderInteractionVO | undefined =
    visibleStatus?.interaction
  const draft = effectiveDraft(currentInteraction, draftState)

  const submitPrimary = useCallback(async (): Promise<void> => {
    if (!currentInteraction) return
    if (visibleActionError?.kind === 'reply' && visibleActionError.unverified) return
    await submitReply(buildPrimaryReply(currentInteraction, draft))
  }, [currentInteraction, draft, submitReply, visibleActionError])

  const accept = useCallback(async (): Promise<void> => {
    if (!visibleStatus || !currentInteraction || !canAccept(visibleStatus, currentInteraction)) return
    await submitReply({ kind: 'accept' })
  }, [currentInteraction, submitReply, visibleStatus])

  const discard = useCallback(async (): Promise<void> => {
    if (!currentInteraction || !canDiscard(currentInteraction)) return
    await submitReply({ kind: 'discard' })
  }, [currentInteraction, submitReply])

  const pause = useCallback(async (): Promise<void> => {
    const current = scopedStatus()
    if (!current || !current.canPause) return
    await runAction('pause', () =>
      client.pause({
        projectId: current.projectId,
        sceneId: current.sceneId,
        operationId: current.operationId
      })
    )
  }, [client, runAction, scopedStatus])

  const resume = useCallback(async (): Promise<void> => {
    const current = scopedStatus()
    if (!current || !current.canResume) return
    const request = resumeRequestOf(current, { projectId, sceneId })
    if (!request) {
      setActionError({
        scope: scopeRef.current,
        value: {
          kind: 'resume',
          message: current.checkpointId
            ? '恢复身份与当前状态不一致，本次生成不可续跑。'
            : '当前任务没有可继续的检查点，本次生成不可续跑。',
          unverified: false
        }
      })
      return
    }
    await runAction('resume', () => client.resume(request))
  }, [client, projectId, runAction, sceneId, scopedStatus])

  const cancel = useCallback(async (): Promise<void> => {
    const current = scopedStatus()
    if (!current || !current.canCancel) return
    await runAction('cancel', () =>
      client.cancel({
        projectId: current.projectId,
        sceneId: current.sceneId,
        operationId: current.operationId
      })
    )
  }, [client, runAction, scopedStatus])

  const retryRepair = useCallback(async (): Promise<void> => {
    if (pendingRef.current !== null) return
    const current = scopedStatus()
    const request = retryRepairRequestOf(current, { projectId, sceneId })
    if (!request) {
      setActionError({
        scope: scopeRef.current,
        value: {
          kind: 'retryRepair',
          message: '这次失败没有可携带的修改要求，不能重试本次修改。',
          unverified: false
        }
      })
      return
    }
    if (blockedReason !== null) {
      setActionError({
        scope: scopeRef.current,
        value: { kind: 'retryRepair', message: blockedReason, unverified: false }
      })
      return
    }
    pendingRef.current = 'retryRepair'
    setPending('retryRepair')
    setActionError(null)
    try {
      const prepared = await prepareGenerationWorkspace(projectClient, projectId)
      if (!prepared.ok) {
        setActionError({
          scope: scopeRef.current,
          value: {
            kind: 'retryRepair',
            message: prepared.message,
            unverified: false,
            workspaceNotReady: prepared.workspaceNotReady
          }
        })
        return
      }
      const saved = await saveCanvas()
      if (!saved.ok) {
        setActionError({
          scope: scopeRef.current,
          value: { kind: 'retryRepair', message: saved.message, unverified: false }
        })
        return
      }
      const result = await client.retryRepair(request)
      if (result.code !== ErrorCodes.success || !result.data) {
        setActionError({
          scope: scopeRef.current,
          value: {
            kind: 'retryRepair',
            message: result.msg,
            unverified: result.code === ErrorCodes.communicationFailed,
            code: result.code
          }
        })
        return
      }
      applyStatus(result.data)
    } catch (error) {
      const failure = failureOf(error)
      setActionError({
        scope: scopeRef.current,
        value: {
          kind: 'retryRepair',
          message: failure.msg,
          unverified: false,
          code: failure.code
        }
      })
    } finally {
      pendingRef.current = null
      setPending(null)
    }
  }, [
    applyStatus,
    blockedReason,
    client,
    projectClient,
    projectId,
    saveCanvas,
    sceneId,
    scopedStatus
  ])

  const selectOption = useCallback((optionId: string | null): void => {
    const interaction = statusRef.current?.interaction
    if (!interaction) return
    setDraftState((previous) => ({ ...effectiveDraft(interaction, previous), optionId }))
  }, [])

  const setBody = useCallback((body: string): void => {
    const interaction = statusRef.current?.interaction
    if (!interaction) return
    setDraftState((previous) => ({ ...effectiveDraft(interaction, previous), body }))
  }, [])

  const selectAnswer = useCallback((questionId: string, optionId: string | null): void => {
    const interaction = statusRef.current?.interaction
    const question = interaction?.questions?.find((item) => item.questionId === questionId)
    if (!interaction || !question) return
    if (optionId !== null && !question.options.some((option) => option.id === optionId)) return
    setDraftState((previous) => {
      const current = effectiveDraft(interaction, previous)
      const answer = current.answers[questionId] ?? { optionId: null, body: '' }
      return {
        ...current,
        answers: { ...current.answers, [questionId]: { ...answer, optionId } }
      }
    })
  }, [])

  const setAnswerBody = useCallback((questionId: string, body: string): void => {
    const interaction = statusRef.current?.interaction
    if (!interaction?.questions?.some((question) => question.questionId === questionId)) return
    setDraftState((previous) => {
      const current = effectiveDraft(interaction, previous)
      const answer = current.answers[questionId] ?? { optionId: null, body: '' }
      return {
        ...current,
        answers: { ...current.answers, [questionId]: { ...answer, body } }
      }
    })
  }, [])

  return {
    status: visibleStatus,
    phase: generationPhaseOf(visibleStatus),
    loading,
    loadError: visibleLoadError,
    unavailableReason,
    pending,
    startPhase,
    actionError: visibleActionError,
    draft,
    progress,
    progressNotice:
      progressNotice?.scope === scope &&
      progressNotice.value.operationId === liveOperationId &&
      liveOperationId !== null
        ? progressNotice.value.message
        : null,
    startBlockedReason: blockedReason,
    start,
    submitPrimary,
    accept,
    discard,
    pause,
    resume,
    cancel,
    retryRepair,
    selectOption,
    selectAnswer,
    setAnswerBody,
    setBody,
    reload
  }
}
