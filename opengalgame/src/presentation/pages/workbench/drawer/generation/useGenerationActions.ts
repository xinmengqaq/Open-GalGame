import { useCallback, useEffect, useState } from 'react'

import type { SceneGenerationReplyDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { failureOf, requireSuccess } from '@presentation/feedback/failure'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '@presentation/feedback/workbenchFeedback'
import { promptReferenceFailureOf } from '@presentation/features/workbench-session/promptReferences'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'

import {
  buildPrimaryReply,
  canAccept,
  canDiscard,
  generationConfirmedControls,
  generationPolicy,
  isTerminalState,
  resumeRequestOf,
  retryRepairRequestOf,
  startBlockedReason,
  type GenerationActionFailure,
  type GenerationActionKind,
  type GenerationDraft,
  type StartBlockerInput
} from './generationPresentation'
import type { UseGenerationStatusResult } from './useGenerationStatus'
import type { MutableRef } from './useGenerationDraft'

export type SaveCanvasOutcome = { ok: true } | { ok: false; message: string }

type Scoped<T> = { scope: string; value: T }

export const WORKSPACE_NOT_READY_GENERATION_MESSAGE = '工程初始化未完成，请重新构建'

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

function createReplyId(): string {
  const random = globalThis.crypto?.randomUUID
  if (typeof random === 'function') return random.call(globalThis.crypto)
  return `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 生成前引用校验失败只落到提示词卡一次。只有结构化 reason 指向引用且画布确有引用时才显示，
 * 避免误导其他无效请求。
 */
function reportPromptReferenceFailure(failure: { code: number; reason?: string }): void {
  const referenceFailure = promptReferenceFailureOf(failure)
  if (!referenceFailure) return
  const state = useWorkbenchSessionStore.getState()
  const hasReferences = state.cards.some(
    (card) => card.kind === 'prompt' && (card.references?.length ?? 0) > 0
  )
  if (!hasReferences) return
  state.setPromptReferenceAlert({ message: referenceFailure.text })
}

interface UseGenerationActionsOptions {
  readonly projectClient: ProjectClient
  readonly client: SceneGenerationClient
  readonly projectId: string
  readonly sceneId: string
  readonly canvasId: string
  readonly saveState: WorkbenchSaveState
  readonly pageBlocked: boolean
  readonly canvasReady: boolean
  readonly saveCanvas: () => Promise<SaveCanvasOutcome>
  readonly status: UseGenerationStatusResult
  readonly draft: GenerationDraft
  readonly pendingRef: MutableRef<GenerationActionKind | null>
}

export interface UseGenerationActionsResult {
  readonly pending: GenerationActionKind | null
  readonly startPhase: 'saving' | 'preparing' | null
  readonly actionError: GenerationActionFailure | null
  readonly startBlockedReason: string | null
  readonly start: () => Promise<void>
  readonly submitPrimary: () => Promise<void>
  readonly accept: () => Promise<void>
  readonly discard: () => Promise<void>
  readonly pause: () => Promise<void>
  readonly resume: () => Promise<void>
  readonly cancel: () => Promise<void>
  readonly retryRepair: () => Promise<void>
}

/**
 * 生成动作的唯一所有者：启动前保存、回复、接受/丢弃、暂停/继续/取消与修复重试。
 * 只通过状态协作者提供的 applyStatus/scope 写入事实，不另存状态或播放状态。
 */
export function useGenerationActions({
  projectClient,
  client,
  projectId,
  sceneId,
  canvasId,
  saveState,
  pageBlocked,
  canvasReady,
  saveCanvas,
  status,
  draft,
  pendingRef
}: UseGenerationActionsOptions): UseGenerationActionsResult {
  const [pending, setPending] = useState<GenerationActionKind | null>(null)
  const [startPhase, setStartPhase] = useState<'saving' | 'preparing' | null>(null)
  const [actionError, setActionError] = useState<Scoped<GenerationActionFailure> | null>(null)

  const { scopeRef, applyStatus, scopedStatus, status: visibleStatus, unavailableReason } = status

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  const visibleActionError = actionError?.scope === status.scope ? actionError.value : null

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
        reportPromptReferenceFailure(result)
        const referenceFailure = promptReferenceFailureOf(result)
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
      reportPromptReferenceFailure(failure)
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

  const currentInteraction = visibleStatus?.interaction

  const submitPrimary = useCallback(async (): Promise<void> => {
    if (!currentInteraction) return
    if (visibleActionError?.kind === 'reply' && visibleActionError.unverified) return
    await submitReply(buildPrimaryReply(currentInteraction, draft))
  }, [currentInteraction, draft, submitReply, visibleActionError])

  const accept = useCallback(async (): Promise<void> => {
    if (!visibleStatus || !currentInteraction || !canAccept(visibleStatus, currentInteraction)) {
      return
    }
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

  return {
    pending,
    startPhase,
    actionError: visibleActionError,
    startBlockedReason: blockedReason,
    start,
    submitPrimary,
    accept,
    discard,
    pause,
    resume,
    cancel,
    retryRepair
  }
}
