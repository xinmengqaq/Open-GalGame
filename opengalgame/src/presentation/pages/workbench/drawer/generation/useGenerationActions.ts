import { useCallback, useRef, useState } from 'react'

import type { SceneGenerationReplyDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationForkVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { failureOf, requireSuccess, type FailureState } from '@presentation/feedback/failure'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '@presentation/feedback/workbenchFeedback'
import { promptReferenceFailureOf } from '@presentation/features/workbench-session/promptReferences'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { WorkbenchSaveState } from '@presentation/features/workbench-session/workbenchSession.types'

import {
  buildPrimaryReply,
  canAccept,
  canDiscard,
  cleanupRetryRequestOf,
  forkRequestOf,
  generationConfirmedControls,
  generationPolicy,
  resumeRequestOf,
  retryRepairRequestOf,
  startBlockedReason,
  startBlockingOperationOf,
  startConflictBlockedReason,
  unfinishedResumeRequestOf,
  unknownVerificationRequestOf,
  type GenerationActionFailure,
  type GenerationActionKind,
  type GenerationDraft,
  type HistoryForkSource,
  type StartBlockerInput
} from './generationPresentation'
import type { UseGenerationStatusResult } from './useGenerationStatus'
import {
  GenerationActionRequestRegistry,
  performGenerationAction,
  visibleActionFailure,
  type GenerationSelectionToken
} from './generationSelectionSession'

export type SaveCanvasOutcome = { ok: true } | { ok: false; message: string }

type ActionFailureRecord = {
  scope: string
  operationId: string | null
  epoch: number
  value: GenerationActionFailure
}

type StartPhaseRecord = {
  id: number
  scope: string
  operationId: string | null
  phase: 'saving' | 'preparing'
}

type StartGateOutcome =
  | { kind: 'workspace-not-ready'; message: string; workspaceNotReady: boolean }
  | { kind: 'save-failed'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'superseded' }

type StartRequestOutcome =
  | StartGateOutcome
  /** 保存或启动抛出的结构化失败；必须经由结果通道，切走后也不能静默丢弃。 */
  | { kind: 'request-failed'; failure: FailureState }
  | { code: number; msg: string; data?: SceneGenerationRenderStatusVO }

type RepairRequestOutcome =
  | StartGateOutcome
  | { code: number; msg: string; data?: SceneGenerationRenderStatusVO }

function actionFailureRecord(
  token: GenerationSelectionToken,
  value: GenerationActionFailure
): ActionFailureRecord {
  return {
    scope: token.scope,
    operationId: token.operationId,
    epoch: token.epoch,
    value
  }
}

export const FORK_UNCONFIRMED_MESSAGE =
  '分支请求已结束，但当前视图已切换；没有自动切换过去，请刷新历史确认结果。'

/** 启动结果因作者已显式切换视图而不能写回时的固定提示；不把视图强行跳回。 */
export const START_SUPERSEDED_NOTICE =
  '生成已启动，但当前视图已切换；没有自动切换过去，请刷新历史查看。'
export const START_ABORTED_NOTICE = '已切换视图，本次启动没有继续。'
export const START_SWITCHED_FAILURE_PREFIX = '刚才的启动请求没有成功：'
/** 通信失败时结果未知：不能写成确认失败，也不引导直接重试。 */
export const START_SWITCHED_UNKNOWN_NOTICE =
  '刚才的启动请求结果待确认，生成可能已经开始；没有自动切换视图，请刷新历史核对。'

const ACTION_IDENTITY_MISMATCH_MESSAGE = '生成状态与当前操作不一致，已保留当前视图。'

function statusIsActionTarget(
  status: SceneGenerationRenderStatusVO,
  token: GenerationSelectionToken,
  projectId: string,
  sceneId: string
): boolean {
  return (
    token.operationId !== null &&
    status.projectId === projectId &&
    status.sceneId === sceneId &&
    status.operationId === token.operationId
  )
}

function statusInScope(
  status: SceneGenerationRenderStatusVO,
  projectId: string,
  sceneId: string
): boolean {
  return status.projectId === projectId && status.sceneId === sceneId
}

/**
 * 已派发的启动完成后，作者已显式切走：只给固定提示，不写回当前视图。
 * 通信失败是“结果未知”，不能说成确认失败，也不引导直接重试。
 */
function startFailureNotice(code: number, message: string): string {
  return code === ErrorCodes.communicationFailed
    ? START_SWITCHED_UNKNOWN_NOTICE
    : `${START_SWITCHED_FAILURE_PREFIX}${message}`
}

function staleStartNotice(result: StartRequestOutcome): string {
  if ('kind' in result) {
    if (result.kind === 'superseded') return START_ABORTED_NOTICE
    if (result.kind === 'request-failed') {
      return startFailureNotice(result.failure.code, result.failure.msg)
    }
    return `${START_SWITCHED_FAILURE_PREFIX}${result.message}`
  }
  if (result.code === ErrorCodes.success && result.data) return START_SUPERSEDED_NOTICE
  return startFailureNotice(result.code, result.msg)
}

export const WORKSPACE_NOT_READY_GENERATION_MESSAGE = '工程初始化未完成，请重新构建'

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
}

export type ForkFromHistoryOutcome =
  | {
      kind: 'forked'
      fork: SceneGenerationForkVO
      /**
       * 后端已确认创建，但结果到达时当前视图已被作者显式切走时为 false：
       * 页面没有自动采纳新分支，不能把它降级成可重试的失败。
       */
      viewSwitched: boolean
    }
  | { kind: 'failed'; message: string; unverified: boolean }
  | { kind: 'busy' }

export interface UseGenerationActionsResult {
  readonly pending: GenerationActionKind | null
  readonly startPhase: 'saving' | 'preparing' | null
  readonly actionError: GenerationActionFailure | null
  /** 已派发的启动因作者显式切走而无法写回当前视图时的固定提示；不改变选择。 */
  readonly startNotice: string | null
  readonly startBlockedReason: string | null
  /** 本次启动是否确实被场景内已有生成挡住；用于只在该情况暴露处理入口。 */
  readonly startBlockedByGeneration: boolean
  /**
   * 修复重跑自己的禁用依据；与启动共用画布/工作区前提，
   * 但不把“已有进行中的普通生成”算进来，避免禁掉合法修复。
   */
  readonly repairBlockedReason: string | null
  readonly start: () => Promise<void>
  readonly submitPrimary: () => Promise<void>
  readonly accept: () => Promise<void>
  readonly discard: () => Promise<void>
  readonly pause: () => Promise<void>
  readonly resume: () => Promise<void>
  readonly resumeUnfinished: () => Promise<void>
  readonly retryCleanup: () => Promise<void>
  readonly verifyResult: () => Promise<void>
  readonly cancel: () => Promise<void>
  readonly retryRepair: () => Promise<void>
  /** 从 AI 历史创建分支；成功时切换页面状态到新操作，失败交给历史内联提示。 */
  readonly forkFromHistory: (source: HistoryForkSource) => Promise<ForkFromHistoryOutcome>
}

/**
 * 生成动作的唯一所有者：启动前保存、回复、接受/丢弃、暂停/继续/取消与修复重试。
 * 只通过状态协作者提供的 applyActionStatus/scope 写入事实，不另存状态或播放状态。
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
  draft
}: UseGenerationActionsOptions): UseGenerationActionsResult {
  const [, setRequestVersion] = useState(0)
  const [startPhaseRecord, setStartPhaseRecord] = useState<StartPhaseRecord | null>(null)
  const [startNotice, setStartNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionFailureRecord | null>(null)
  const [requests] = useState(() => new GenerationActionRequestRegistry())
  const startPhaseId = useRef(0)

  const {
    applyActionStatus,
    scopedStatus,
    status: visibleStatus,
    statusCheck,
    unavailableReason,
    unfinished,
    scopeRef,
    selectionToken,
    isSelectionCurrent,
    selectionIntent
  } = status

  const bumpRequests = useCallback((): void => {
    setRequestVersion((version) => version + 1)
  }, [])

  const currentOperationId = visibleStatus?.operationId ?? null
  const pending = requests.visibleKind(status.scope, currentOperationId)
  const startPhase =
    startPhaseRecord !== null &&
    startPhaseRecord.scope === status.scope &&
    startPhaseRecord.operationId === currentOperationId
      ? startPhaseRecord.phase
      : null
  const visibleActionError = visibleActionFailure(actionError, isSelectionCurrent)

  const beginStartPhase = useCallback(
    (token: GenerationSelectionToken): number => {
      const id = ++startPhaseId.current
      setStartPhaseRecord({
        id,
        scope: token.scope,
        operationId: token.operationId,
        phase: 'saving'
      })
      return id
    },
    []
  )

  const updateStartPhase = useCallback(
    (id: number, phase: 'saving' | 'preparing'): void => {
      setStartPhaseRecord((record) => (record?.id === id ? { ...record, phase } : record))
    },
    []
  )

  const endStartPhase = useCallback((id: number): void => {
    setStartPhaseRecord((record) => (record?.id === id ? null : record))
  }, [])

  const blockingOperation = startBlockingOperationOf(visibleStatus, unfinished)
  const blockerInput: StartBlockerInput = {
    saveState,
    pageBlocked,
    canvasReady,
    statusCheck,
    blockingOperation,
    unavailableReason
  }
  const blockedReason = startBlockedReason(blockerInput)
  // 修复等非 generate 模式不占生成位置；同一事实只对普通启动生效。
  const repairBlockedReason = startBlockedReason(blockerInput, 'repair')
  const startBlockedByGeneration =
    blockingOperation !== null &&
    blockedReason === startConflictBlockedReason(blockingOperation)

  const runAction = useCallback(
    async (
      kind: GenerationActionKind,
      request: () => Promise<{ code: number; msg: string; data?: SceneGenerationRenderStatusVO }>
    ): Promise<void> => {
      const token = selectionToken()
      await performGenerationAction({
        registry: requests,
        token,
        kind,
        isCurrent: isSelectionCurrent,
        request,
        onChange: bumpRequests,
        onStart: () => setActionError(null),
        onResult: (result) => {
          if (result.code !== ErrorCodes.success || !result.data) {
            setActionError(
              actionFailureRecord(token, {
                kind,
                message: result.msg,
                unverified: result.code === ErrorCodes.communicationFailed,
                code: result.code
              })
            )
            return
          }
          if (!statusIsActionTarget(result.data, token, projectId, sceneId)) {
            setActionError(
              actionFailureRecord(token, {
                kind,
                message: ACTION_IDENTITY_MISMATCH_MESSAGE,
                unverified: true
              })
            )
            return
          }
          applyActionStatus(result.data)
        },
        onFailure: (failure) => setActionError(actionFailureRecord(token, failure))
      })
    },
    [
      applyActionStatus,
      bumpRequests,
      isSelectionCurrent,
      projectId,
      requests,
      sceneId,
      selectionToken
    ]
  )

  const start = useCallback(async (): Promise<void> => {
    const token = selectionToken()
    const intent = selectionIntent()
    /* 只有作者显式切任务或切场景才会让这次启动失去写回资格；读回只是更新视图。 */
    const ownsStart = (): boolean =>
      token.scope === scopeRef.current && selectionIntent() === intent
    if (blockedReason !== null) {
      setActionError(
        actionFailureRecord(token, { kind: 'start', message: blockedReason, unverified: false })
      )
      return
    }
    if (!projectId || !sceneId || !canvasId) return
    let phaseId: number | null = null

    const settleStart = (
      result: StartRequestOutcome,
      resultToken: GenerationSelectionToken
    ): void => {
      if ('kind' in result) {
        if (result.kind === 'superseded') {
          setStartNotice(START_ABORTED_NOTICE)
          return
        }
        if (result.kind === 'request-failed') {
          reportPromptReferenceFailure(result.failure)
          const referenceFailure = promptReferenceFailureOf(result.failure)
          const message = referenceFailure?.text ?? result.failure.msg
          setStartNotice(startFailureNotice(result.failure.code, message))
          setActionError(
            actionFailureRecord(resultToken, {
              kind: 'start',
              message,
              unverified: false,
              code: result.failure.code
            })
          )
          return
        }
        setStartNotice(`${START_SWITCHED_FAILURE_PREFIX}${result.message}`)
        setActionError(
          actionFailureRecord(resultToken, {
            kind: 'start',
            message: result.message,
            unverified: false,
            ...(result.kind === 'workspace-not-ready'
              ? { workspaceNotReady: result.workspaceNotReady }
              : {})
          })
        )
        return
      }
      if (result.code !== ErrorCodes.success || !result.data) {
        reportPromptReferenceFailure(result)
        const referenceFailure = promptReferenceFailureOf(result)
        const message = referenceFailure?.text ?? result.msg
        setStartNotice(startFailureNotice(result.code, message))
        setActionError(
          actionFailureRecord(resultToken, {
            kind: 'start',
            message,
            unverified: result.code === ErrorCodes.communicationFailed,
            code: result.code
          })
        )
        return
      }
      if (!statusInScope(result.data, projectId, sceneId)) {
        setStartNotice(`${START_SWITCHED_FAILURE_PREFIX}${ACTION_IDENTITY_MISMATCH_MESSAGE}`)
        setActionError(
          actionFailureRecord(resultToken, {
            kind: 'start',
            message: ACTION_IDENTITY_MISMATCH_MESSAGE,
            unverified: true
          })
        )
        return
      }
      setStartNotice(null)
      useWorkbenchSessionStore.getState().setPromptReferenceAlert(null)
      applyActionStatus(result.data)
    }

    await performGenerationAction<StartRequestOutcome>({
      registry: requests,
      token,
      kind: 'start',
      isCurrent: isSelectionCurrent,
      onChange: bumpRequests,
      onStart: () => {
        setActionError(null)
        setStartNotice(null)
        phaseId = beginStartPhase(token)
        useWorkbenchSessionStore.getState().setPromptReferenceAlert(null)
      },
      request: async () => {
        try {
          /* 保存和准备期间可能有读回把场景切到旧操作：用同一个门禁实时复核一次。 */
          const gate = (): StartRequestOutcome | null => {
            if (!ownsStart()) return { kind: 'superseded' }
            const live = scopedStatus()
            const reason = startBlockedReason({
              saveState,
              pageBlocked,
              canvasReady,
              statusCheck,
              blockingOperation: startBlockingOperationOf(live, unfinished),
              unavailableReason
            })
            return reason === null ? null : { kind: 'blocked', message: reason }
          }
          const prepared = await prepareGenerationWorkspace(projectClient, projectId)
          if (!prepared.ok) {
            return {
              kind: 'workspace-not-ready',
              message: prepared.message,
              workspaceNotReady: prepared.workspaceNotReady
            }
          }
          const afterPrepare = gate()
          if (afterPrepare !== null) return afterPrepare
          const saved = await saveCanvas()
          if (!saved.ok) return { kind: 'save-failed', message: saved.message }
          const afterSave = gate()
          if (afterSave !== null) return afterSave
          if (phaseId !== null) updateStartPhase(phaseId, 'preparing')
          return await client.start({
            projectId,
            sceneId,
            canvasId,
            confirmedControls: generationConfirmedControls,
            policy: generationPolicy
          })
        } catch (error) {
          return { kind: 'request-failed', failure: failureOf(error) }
        }
      },
      onResult: (result) => settleStart(result, selectionToken()),
      onStale: (result) => {
        if (!ownsStart()) {
          /* 作者真的切走了：不写回、不刷新跳转，只用固定提示保留原动作归属。 */
          setStartNotice(staleStartNotice(result))
          return
        }
        /* 只是读回被动更新了视图：按当前代次收下结果，成功/失败都不能静默消失。 */
        settleStart(result, selectionToken())
      },
      onFailure: (failure, error) => {
        const structured = failureOf(error)
        reportPromptReferenceFailure(structured)
        const referenceFailure = promptReferenceFailureOf(structured)
        const message = referenceFailure?.text ?? failure.message
        setStartNotice(startFailureNotice(failure.code ?? structured.code, message))
        setActionError(
          actionFailureRecord(token, {
            kind: 'start',
            message,
            unverified: false,
            code: failure.code
          })
        )
      },
      onSettled: () => {
        if (phaseId !== null) endStartPhase(phaseId)
      }
    })
  }, [
    applyActionStatus,
    beginStartPhase,
    blockedReason,
    bumpRequests,
    canvasId,
    canvasReady,
    client,
    endStartPhase,
    isSelectionCurrent,
    pageBlocked,
    projectClient,
    projectId,
    requests,
    saveCanvas,
    saveState,
    sceneId,
    scopeRef,
    scopedStatus,
    selectionIntent,
    selectionToken,
    statusCheck,
    unavailableReason,
    unfinished,
    updateStartPhase
  ])

  const submitReply = useCallback(
    async (reply: SceneGenerationReplyDTO | null): Promise<void> => {
      const current = scopedStatus()
      const interaction = current?.interaction
      if (!current || !interaction || reply === null) return
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
    const token = selectionToken()
    const current = scopedStatus()
    if (!current || !current.canResume) return
    const request = resumeRequestOf(current, { projectId, sceneId })
    if (!request) {
      setActionError(
        actionFailureRecord(token, {
          kind: 'resume',
          message: current.checkpointId
            ? '恢复身份与当前状态不一致，本次生成不可续跑。'
            : '当前任务没有可继续的检查点，本次生成不可续跑。',
          unverified: false
        })
      )
      return
    }
    await runAction('resume', () => client.resume(request))
  }, [client, projectId, runAction, sceneId, scopedStatus, selectionToken])

  const resumeUnfinished = useCallback(async (): Promise<void> => {
    const token = selectionToken()
    const current = scopedStatus()
    const request = unfinishedResumeRequestOf(current, { projectId, sceneId })
    if (!request) {
      if (current) {
        setActionError(
          actionFailureRecord(token, {
            kind: 'resumeUnfinished',
            message: '当前状态没有可继续的未完成生成，未发送恢复请求。',
            unverified: false
          })
        )
      }
      return
    }
    await runAction('resumeUnfinished', () => client.resumeUnfinished(request))
  }, [client, projectId, runAction, sceneId, scopedStatus, selectionToken])

  const retryCleanup = useCallback(async (): Promise<void> => {
    const token = selectionToken()
    const current = scopedStatus()
    const request = cleanupRetryRequestOf(current, { projectId, sceneId })
    if (!request) {
      if (current) {
        setActionError(
          actionFailureRecord(token, {
            kind: 'retryCleanup',
            message: '当前没有可重试的提交后清理。',
            unverified: false
          })
        )
      }
      return
    }
    await runAction('retryCleanup', () => client.retryCleanup(request))
  }, [client, projectId, runAction, sceneId, scopedStatus, selectionToken])

  const verifyResult = useCallback(async (): Promise<void> => {
    const token = selectionToken()
    const current = scopedStatus()
    const request = unknownVerificationRequestOf(current, { projectId, sceneId })
    if (!request) {
      if (current) {
        setActionError(
          actionFailureRecord(token, {
            kind: 'verifyResult',
            message: '当前状态没有可核对的结果，未发送核对请求。',
            unverified: false
          })
        )
      }
      return
    }
    await performGenerationAction({
      registry: requests,
      token,
      kind: 'verifyResult',
      isCurrent: isSelectionCurrent,
      onChange: bumpRequests,
      onStart: () => setActionError(null),
      request: () => client.verifyUnknownResult(request),
      onResult: (result) => {
        if (result.code !== ErrorCodes.success || !result.data) {
          setActionError(
            actionFailureRecord(token, {
              kind: 'verifyResult',
              message: result.msg,
              unverified: result.code === ErrorCodes.communicationFailed,
              code: result.code
            })
          )
          return
        }
        if (!statusIsActionTarget(result.data.status, token, projectId, sceneId)) {
          setActionError(
            actionFailureRecord(token, {
              kind: 'verifyResult',
              message: ACTION_IDENTITY_MISMATCH_MESSAGE,
              unverified: true
            })
          )
          return
        }
        applyActionStatus(result.data.status)
        // 核对的固定结论直接展示；仍待核对不冒充失败或可继续，也不改动其它页面状态。
        setActionError(
          actionFailureRecord(token, {
            kind: 'verifyResult',
            message: result.data.message,
            unverified: result.data.outcome === 'stillPending'
          })
        )
      },
      onFailure: (failure) => setActionError(actionFailureRecord(token, failure))
    })
  }, [
    applyActionStatus,
    bumpRequests,
    client,
    isSelectionCurrent,
    projectId,
    requests,
    sceneId,
    scopedStatus,
    selectionToken
  ])

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
    const token = selectionToken()
    const current = scopedStatus()
    const request = retryRepairRequestOf(current, { projectId, sceneId })
    if (!request) {
      setActionError(
        actionFailureRecord(token, {
          kind: 'retryRepair',
          message: '这次失败没有可携带的修改要求，不能重试本次修改。',
          unverified: false
        })
      )
      return
    }
    if (repairBlockedReason !== null) {
      setActionError(
        actionFailureRecord(token, {
          kind: 'retryRepair',
          message: repairBlockedReason,
          unverified: false
        })
      )
      return
    }
    await performGenerationAction<RepairRequestOutcome>({
      registry: requests,
      token,
      kind: 'retryRepair',
      isCurrent: isSelectionCurrent,
      onChange: bumpRequests,
      onStart: () => setActionError(null),
      request: async () => {
        const prepared = await prepareGenerationWorkspace(projectClient, projectId)
        if (!prepared.ok) {
          return {
            kind: 'workspace-not-ready',
            message: prepared.message,
            workspaceNotReady: prepared.workspaceNotReady
          }
        }
        if (!isSelectionCurrent(token)) return { kind: 'superseded' }
        const saved = await saveCanvas()
        if (!saved.ok) return { kind: 'save-failed', message: saved.message }
        if (!isSelectionCurrent(token)) return { kind: 'superseded' }
        return client.retryRepair(request)
      },
      onResult: (result) => {
        if ('kind' in result) {
          if (result.kind === 'superseded') return
          setActionError(
            actionFailureRecord(token, {
              kind: 'retryRepair',
              message: result.message,
              unverified: false,
              ...(result.kind === 'workspace-not-ready'
                ? { workspaceNotReady: result.workspaceNotReady }
                : {})
            })
          )
          return
        }
        if (result.code !== ErrorCodes.success || !result.data) {
          setActionError(
            actionFailureRecord(token, {
              kind: 'retryRepair',
              message: result.msg,
              unverified: result.code === ErrorCodes.communicationFailed,
              code: result.code
            })
          )
          return
        }
        if (!statusInScope(result.data, projectId, sceneId)) {
          setActionError(
            actionFailureRecord(token, {
              kind: 'retryRepair',
              message: ACTION_IDENTITY_MISMATCH_MESSAGE,
              unverified: true
            })
          )
          return
        }
        applyActionStatus(result.data)
      },
      onFailure: (failure) => setActionError(actionFailureRecord(token, failure))
    })
  }, [
    applyActionStatus,
    bumpRequests,
    client,
    isSelectionCurrent,
    projectClient,
    projectId,
    repairBlockedReason,
    requests,
    saveCanvas,
    sceneId,
    scopedStatus,
    selectionToken
  ])

  const forkFromHistory = useCallback(
    async (source: HistoryForkSource): Promise<ForkFromHistoryOutcome> => {
      const token = selectionToken()
      const request = forkRequestOf(source, { projectId, sceneId })
      if (!request) {
        return {
          kind: 'failed',
          message: '这条历史不属于当前场景，没有创建分支。',
          unverified: false
        }
      }
      let outcome: ForkFromHistoryOutcome | null = null
      const settled = await performGenerationAction({
        registry: requests,
        token,
        kind: 'fork',
        isCurrent: isSelectionCurrent,
        onChange: bumpRequests,
        onStart: () => setActionError(null),
        request: () => client.fork(request),
        onResult: (result) => {
          if (result.code !== ErrorCodes.success || !result.data) {
            outcome = {
              kind: 'failed',
              message: result.msg,
              unverified: result.code === ErrorCodes.communicationFailed
            }
            return
          }
          if (!statusInScope(result.data.status, projectId, sceneId)) {
            outcome = {
              kind: 'failed',
              message: ACTION_IDENTITY_MISMATCH_MESSAGE,
              unverified: true
            }
            return
          }
          applyActionStatus(result.data.status)
          outcome = { kind: 'forked', fork: result.data, viewSwitched: true }
        },
        onStale: (result) => {
          outcome =
            result.code === ErrorCodes.success && result.data
              ? { kind: 'forked', fork: result.data, viewSwitched: false }
              : {
                  kind: 'failed',
                  message: result.msg,
                  unverified: result.code === ErrorCodes.communicationFailed
                }
        },
        onFailure: (failure) => {
          outcome = { kind: 'failed', message: failure.message, unverified: false }
        }
      })
      if (settled === 'busy') return { kind: 'busy' }
      return outcome ?? { kind: 'failed', message: FORK_UNCONFIRMED_MESSAGE, unverified: true }
    },
    [
      applyActionStatus,
      bumpRequests,
      client,
      isSelectionCurrent,
      projectId,
      requests,
      sceneId,
      selectionToken
    ]
  )

  return {
    pending,
    startPhase,
    actionError: visibleActionError,
    startNotice,
    startBlockedReason: blockedReason,
    startBlockedByGeneration,
    repairBlockedReason,
    start,
    submitPrimary,
    accept,
    discard,
    pause,
    resume,
    resumeUnfinished,
    retryCleanup,
    verifyResult,
    cancel,
    retryRepair,
    forkFromHistory
  }
}
