import { useCallback, useEffect, useRef, useState } from 'react'

import type { DialogueTextEditDTO } from '@application/scene-preview/dto/DialogueSaveDTO'
import type { PreviewUpdateVO } from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewPhase,
  PreviewPositionVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import {
  subscribeRuntimeStage,
  type GameStageEvent,
  type GameStageRuntimePosition
} from '@presentation/features/game-stage/gameStageEvents'

import {
  dialogueNumber,
  draftUnavailableLabels,
  failureFromError,
  previewUpdateCopy,
  type PreviewFailureView,
  type PreviewNoticeAction
} from './previewPresentation'
import { isLatestDraftRevision, nextDraftRevision } from './previewDraftSequencer'

export type PreviewStageUiState =
  | { readonly status: 'idle' }
  | { readonly status: 'preparing' }
  | { readonly status: 'ready'; readonly stageUrl: string }
  | { readonly status: 'failed'; readonly failure: PreviewFailureView }

export type PreviewUpdateNotice = {
  readonly tone: 'ok' | 'warning' | 'quiet'
  readonly message: string
  readonly action: PreviewNoticeAction
  readonly dialogueId: string | null
}

type MutableRef<T> = { current: T }

interface UseScenePreviewStageOptions {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
  readonly session: ScenePreviewSessionVO | null
  readonly selectedDialogueIdRef: MutableRef<string | null>
  readonly draftsRef: MutableRef<Record<string, string>>
  readonly baselineRef: MutableRef<Record<string, string>>
  readonly saveInFlightRef: MutableRef<boolean>
  readonly onSelectDialogue: (dialogueId: string) => void
}

export interface UseScenePreviewStageResult {
  readonly stage: PreviewStageUiState
  readonly phase: PreviewPhase
  readonly position: PreviewPositionVO
  readonly stageBusy: boolean
  readonly iframeLoaded: boolean
  /** 画面已到达但还没有真实句位：正在处理语言和标题层，不能当作就绪。 */
  readonly startupPending: boolean
  readonly frameToken: number
  readonly controlsBlockedReason: string | null
  readonly locateFailure: PreviewFailureView | null
  readonly previewUpdateNotice: PreviewUpdateNotice | null
  readonly draftNotice: string | null
  readonly subscriptionNotice: string | null
  readonly canPrevious: boolean
  readonly canNext: boolean
  readonly onStageLoad: () => void
  readonly reloadFrame: () => void
  readonly prepareAgain: () => void
  readonly locateDialogue: (dialogueId: string) => void
  readonly retryLocate: () => void
  readonly retrySavedLocate: () => void
  readonly previousDialogue: () => void
  readonly nextDialogue: () => void
  readonly replayScene: () => void
  readonly scheduleDraft: (dialogueId: string, text: string) => void
  readonly flushDraft: () => void
  readonly waitForIdle: () => Promise<void>
  readonly adoptRuntimeGeneration: (runtimeGeneration: number) => void
  readonly acknowledgeSaved: (edits: readonly DialogueTextEditDTO[]) => void
  readonly applyPreviewUpdate: (update: PreviewUpdateVO, dialogueId: string | null) => void
  readonly showSettlementSyncNotice: (dialogueId: string | null) => void
  readonly clearPreviewUpdateNotice: () => void
  readonly resetStage: () => void
}

type PendingDraft = {
  readonly dialogueId: string
  readonly text: string
  readonly revision: number
  readonly mode: 'draft' | 'revert'
}

const draftDelayMs = 360
const stageRetryDelayMs = 460
const stageCommandAttempts = 3

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  window.setTimeout(resolve, ms)
  return promise
}

function retryableLocateFailure(failure: PreviewFailureView): boolean {
  return (
    failure.code === 'runtimeNotReady' ||
    failure.code === 'commandTimeout' ||
    failure.code === 'runtimeDisconnected' ||
    failure.code === null
  )
}

/**
 * 当前场景的舞台会话：订阅、准备、按句定位、草稿和相邻句切换。
 * 只把真实返回和事件写入状态；iframe load 只允许触发一次真实定位，不代表引擎就绪。
 */
export function useScenePreviewStage({
  client,
  projectId,
  sceneId,
  session,
  selectedDialogueIdRef,
  draftsRef,
  baselineRef,
  saveInFlightRef,
  onSelectDialogue
}: UseScenePreviewStageOptions): UseScenePreviewStageResult {
  const [stage, setStage] = useState<PreviewStageUiState>({ status: 'idle' })
  const [phase, setPhase] = useState<PreviewPhase>('unknown')
  const [position, setPosition] = useState<PreviewPositionVO>({ kind: 'unknown' })
  const [stageBusy, setStageBusy] = useState(false)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [startupPending, setStartupPending] = useState(false)
  const [frameToken, setFrameToken] = useState(0)
  const [controlsBlockedReason, setControlsBlockedReason] = useState<string | null>(null)
  const [locateFailure, setLocateFailure] = useState<PreviewFailureView | null>(null)
  const [previewUpdateNotice, setPreviewUpdateNotice] = useState<PreviewUpdateNotice | null>(null)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const [subscriptionNotice, setSubscriptionNotice] = useState<string | null>(null)

  const sessionRef = useRef<ScenePreviewSessionVO | null>(session)
  const stageRef = useRef<PreviewStageUiState>({ status: 'idle' })
  const phaseRef = useRef<PreviewPhase>('unknown')
  const positionRef = useRef<PreviewPositionVO>({ kind: 'unknown' })
  const generationRef = useRef(0)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const queueTokenRef = useRef(0)
  const workCountRef = useRef(0)
  const locateTokenRef = useRef(0)
  const draftTimerRef = useRef<number | null>(null)
  const pendingDraftRef = useRef<PendingDraft | null>(null)
  const draftRevisionRef = useRef(0)
  const sentDraftIdsRef = useRef(new Set<string>())
  const preparedSessionRef = useRef<string | null>(null)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const updateStage = useCallback((next: PreviewStageUiState) => {
    stageRef.current = next
    setStage(next)
  }, [])

  const applyRuntimeStage = useCallback(
    (next: GameStageRuntimePosition, syncSelection: boolean) => {
      generationRef.current = next.runtimeGeneration
      phaseRef.current = next.phase
      positionRef.current = next.position
      setPhase(next.phase)
      setPosition(next.position)
      if (next.position.kind !== 'unknown') setStartupPending(false)
      if (syncSelection && next.position.kind === 'dialogue') {
        selectedDialogueIdRef.current = next.position.dialogueId
        onSelectDialogue(next.position.dialogueId)
      }
    },
    [onSelectDialogue, selectedDialogueIdRef]
  )

  const runStageWork = useCallback((work: () => Promise<void>) => {
    const token = queueTokenRef.current
    workCountRef.current += 1
    setStageBusy(true)
    const run = async (): Promise<void> => {
      try {
        if (token === queueTokenRef.current) await work()
      } catch {
        // 客户端把请求失败收成响应；队列不能因单个任务失败而中断。
      } finally {
        workCountRef.current = Math.max(0, workCountRef.current - 1)
        if (workCountRef.current === 0) setStageBusy(false)
      }
    }
    queueRef.current = queueRef.current.then(run, run)
  }, [])

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
  }, [])

  const runPrepare = useCallback(
    (target: ScenePreviewSessionVO) => {
      setIframeLoaded(false)
      setStartupPending(false)
      setFrameToken((value) => value + 1)
      updateStage({ status: 'preparing' })
      phaseRef.current = 'unknown'
      positionRef.current = { kind: 'unknown' }
      setPhase('unknown')
      setPosition(positionRef.current)
      setLocateFailure(null)
      setPreviewUpdateNotice(null)
      setDraftNotice(null)
      setSubscriptionNotice(null)
      setControlsBlockedReason(null)
      const token = queueTokenRef.current
      runStageWork(async () => {
        const result = await client.prepareStage({ previewSessionId: target.previewSessionId })
        if (
          token !== queueTokenRef.current ||
          sessionRef.current?.previewSessionId !== target.previewSessionId
        ) {
          return
        }
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          updateStage({
            status: 'failed',
            failure: {
              code: null,
              message: '舞台没有加载成功。左侧台词仍然可以修改和保存。',
              recovery: 'retry'
            }
          })
          return
        }
        if (result.data.status === 'failed') {
          const failure = failureFromError(result.data.failure)
          updateStage({ status: 'failed', failure })
          if (result.data.failure.code === 'engineCapabilityUnavailable') {
            setControlsBlockedReason(failure.message)
          }
          return
        }
        applyRuntimeStage(result.data.stage, false)
        updateStage({ status: 'ready', stageUrl: result.data.stageUrl })
      })
    },
    [applyRuntimeStage, client, runStageWork, updateStage]
  )

  const handleRuntimeEvent = useCallback(
    (event: GameStageEvent) => {
      const opened = sessionRef.current
      if (opened === null || event.identity.previewSessionId !== opened.previewSessionId) return
      if (event.type === 'ready') {
        if (event.runtime !== null) applyRuntimeStage(event.runtime, false)
        return
      }
      if (event.type !== 'failed' || event.failure === null) return
      if (event.lastConfirmed?.kind === 'known') {
        phaseRef.current = event.lastConfirmed.phase
        positionRef.current = event.lastConfirmed.position
        setPhase(event.lastConfirmed.phase)
        setPosition(event.lastConfirmed.position)
      }
      const failure = failureFromError(event.failure)
      setLocateFailure(failure)
      setStartupPending(false)
      if (
        event.failure.code === 'engineCapabilityUnavailable' ||
        event.failure.code === 'runtimeDisconnected' ||
        event.failure.code === 'runtimeNotPrepared' ||
        event.failure.code === 'sessionClosed'
      ) {
        setControlsBlockedReason(failure.message)
      }
    },
    [applyRuntimeStage]
  )

  useEffect(() => {
    if (session === null) return
    let active = true
    const unsubscribe = subscribeRuntimeStage(
      client,
      { previewSessionId: session.previewSessionId, projectId, sceneId },
      (event) => {
        if (!active) return
        handleRuntimeEvent(event)
      },
      (message) => {
        if (!active) return
        setSubscriptionNotice(message)
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [client, handleRuntimeEvent, projectId, sceneId, session])

  useEffect(() => {
    if (session === null) {
      preparedSessionRef.current = null
      return
    }
    if (preparedSessionRef.current === session.previewSessionId) return
    preparedSessionRef.current = session.previewSessionId
    runPrepare(session)
  }, [runPrepare, session])

  const flushDraft = useCallback(() => {
    clearDraftTimer()
    if (saveInFlightRef.current) return
    const target = pendingDraftRef.current
    if (target === null) return
    pendingDraftRef.current = null
    if (!isLatestDraftRevision(draftRevisionRef.current, target.revision)) return
    const opened = sessionRef.current
    if (opened === null) return
    const failureNotice =
      target.mode === 'revert'
        ? '已恢复输入；舞台暂时没有回退，可能还显示上一版草稿。'
        : '草稿没有送到舞台，左侧内容不受影响。'
    if (stageRef.current.status !== 'ready' || generationRef.current <= 0) {
      if (target.mode === 'revert') setDraftNotice(failureNotice)
      return
    }
    const token = queueTokenRef.current
    runStageWork(async () => {
      if (token !== queueTokenRef.current) return
      if (!isLatestDraftRevision(draftRevisionRef.current, target.revision)) return
      const result = await client.previewDialogueDraft({
        previewSessionId: opened.previewSessionId,
        expectedRuntimeGeneration: generationRef.current,
        dialogueId: target.dialogueId,
        editRevision: target.revision,
        text: target.text
      })
      if (token !== queueTokenRef.current) return
      if (!isLatestDraftRevision(draftRevisionRef.current, target.revision)) return
      if (result.code !== ErrorCodes.success || result.data === undefined) {
        setDraftNotice(failureNotice)
        return
      }
      if (result.data.status === 'unavailable') {
        setDraftNotice(draftUnavailableLabels[result.data.reason])
        return
      }
      generationRef.current = result.data.runtimeGeneration
      positionRef.current = { kind: 'dialogue', dialogueId: result.data.dialogueId }
      selectedDialogueIdRef.current = result.data.dialogueId
      onSelectDialogue(result.data.dialogueId)
      setPhase('unknown')
      setPosition(positionRef.current)
      if (target.mode === 'draft') sentDraftIdsRef.current.add(target.dialogueId)
      else sentDraftIdsRef.current.delete(target.dialogueId)
      setDraftNotice(target.mode === 'revert' ? '已恢复为保存时的文字。' : null)
      setLocateFailure(null)
    })
  }, [
    clearDraftTimer,
    client,
    onSelectDialogue,
    runStageWork,
    saveInFlightRef,
    selectedDialogueIdRef
  ])

  const scheduleDraft = useCallback(
    (dialogueId: string, text: string) => {
      const revision = nextDraftRevision(draftRevisionRef.current)
      draftRevisionRef.current = revision
      clearDraftTimer()
      const baselineText = baselineRef.current[dialogueId]
      const revert = text.trim() === '' || text === baselineText
      setDraftNotice(null)
      if (!revert) {
        pendingDraftRef.current = { dialogueId, text, revision, mode: 'draft' }
        draftTimerRef.current = window.setTimeout(() => {
          draftTimerRef.current = null
          flushDraft()
        }, draftDelayMs)
        return
      }
      if (!sentDraftIdsRef.current.has(dialogueId)) {
        pendingDraftRef.current = null
        return
      }
      if (baselineText === undefined || baselineText.trim() === '') {
        pendingDraftRef.current = null
        setDraftNotice('这句原文也是空的，舞台暂时无法显示回退。')
        return
      }
      pendingDraftRef.current = {
        dialogueId,
        text: baselineText,
        revision,
        mode: 'revert'
      }
      flushDraft()
    },
    [baselineRef, clearDraftTimer, flushDraft]
  )

  const locate = useCallback(
    (dialogueId: string, allowRetry: boolean, onlyIfUnlocated = false) => {
      selectedDialogueIdRef.current = dialogueId
      onSelectDialogue(dialogueId)
      if (sessionRef.current === null) return
      if (stageRef.current.status !== 'ready') return
      if (saveInFlightRef.current) return
      if (
        onlyIfUnlocated &&
        positionRef.current.kind === 'dialogue' &&
        positionRef.current.dialogueId === dialogueId
      ) {
        return
      }
      const token = queueTokenRef.current
      const locateToken = ++locateTokenRef.current
      setLocateFailure(null)
      runStageWork(async () => {
        if (token !== queueTokenRef.current) return
        let failure: PreviewFailureView | null = null
        const attempts = allowRetry ? stageCommandAttempts : 1
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (attempt > 0) await wait(stageRetryDelayMs)
          if (token !== queueTokenRef.current || locateToken !== locateTokenRef.current) return
          if (stageRef.current.status !== 'ready') break
          if (
            onlyIfUnlocated &&
            positionRef.current.kind === 'dialogue' &&
            positionRef.current.dialogueId === dialogueId
          ) {
            return
          }
          const opened = sessionRef.current
          if (opened === null) return
          const result = await client.selectPreviewDialogue({
            previewSessionId: opened.previewSessionId,
            expectedRuntimeGeneration: generationRef.current,
            dialogueId
          })
          if (token !== queueTokenRef.current || locateToken !== locateTokenRef.current) return
          if (result.code !== ErrorCodes.success || result.data === undefined) {
            failure = {
              code: null,
              message:
                result.code === ErrorCodes.communicationFailed
                  ? '没有联系上舞台，可以重试定位。'
                  : '这次定位没有完成，请重试。',
              recovery: 'retry'
            }
            if (result.code !== ErrorCodes.communicationFailed) break
            continue
          }
          if (result.data.status === 'confirmed') {
            applyRuntimeStage(result.data.stage, true)
            setLocateFailure(null)
            setPreviewUpdateNotice(null)
            setDraftNotice(null)
            return
          }
          failure = failureFromError(result.data.failure)
          if (!retryableLocateFailure(failure)) break
        }
        setLocateFailure(failure)
        setStartupPending(false)
      })
    },
    [
      applyRuntimeStage,
      client,
      onSelectDialogue,
      runStageWork,
      saveInFlightRef,
      selectedDialogueIdRef
    ]
  )

  useEffect(() => {
    if (!iframeLoaded || session === null) return
    if (stageRef.current.status !== 'ready') return
    const target = selectedDialogueIdRef.current ?? session.dialogues[0]?.dialogueId ?? null
    if (target === null) return
    locate(target, true, true)
    const draft = draftsRef.current[target]
    if (draft !== undefined && draft.trim() !== '') scheduleDraft(target, draft)
  }, [draftsRef, iframeLoaded, locate, scheduleDraft, selectedDialogueIdRef, session, stage.status])

  const onStageLoad = useCallback(() => {
    setIframeLoaded(true)
    setStartupPending(true)
  }, [])

  const reloadFrame = useCallback(() => {
    setIframeLoaded(false)
    setStartupPending(false)
    setFrameToken((value) => value + 1)
  }, [])

  const prepareAgain = useCallback(() => {
    if (session === null) return
    preparedSessionRef.current = session.previewSessionId
    runPrepare(session)
  }, [runPrepare, session])

  const stepDialogue = useCallback(
    (direction: -1 | 1) => {
      const opened = sessionRef.current
      if (opened === null || stageRef.current.status !== 'ready') return
      if (saveInFlightRef.current) return
      if (positionRef.current.kind !== 'dialogue') return
      const dialogueId = positionRef.current.dialogueId
      const token = queueTokenRef.current
      const locateToken = ++locateTokenRef.current
      setLocateFailure(null)
      runStageWork(async () => {
        if (token !== queueTokenRef.current) return
        const request = {
          previewSessionId: opened.previewSessionId,
          expectedRuntimeGeneration: generationRef.current,
          dialogueId
        }
        const result =
          direction === -1
            ? await client.playPreviousDialogue(request)
            : await client.playNextDialogue(request)
        if (token !== queueTokenRef.current || locateToken !== locateTokenRef.current) return
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setLocateFailure({
            code: null,
            message: '没有切到相邻台词，请重试。',
            recovery: 'retry'
          })
          return
        }
        if (result.data.status === 'confirmed') {
          applyRuntimeStage(result.data.stage, true)
          setLocateFailure(null)
          setPreviewUpdateNotice(null)
          setDraftNotice(null)
          return
        }
        setLocateFailure(failureFromError(result.data.failure))
      })
    },
    [applyRuntimeStage, client, runStageWork, saveInFlightRef]
  )

  const replayScene = useCallback(() => {
    const first = sessionRef.current?.dialogues[0]
    if (first === undefined) return
    locate(first.dialogueId, true)
  }, [locate])

  const retryLocate = useCallback(() => {
    const target =
      selectedDialogueIdRef.current ??
      (positionRef.current.kind === 'dialogue' ? positionRef.current.dialogueId : null) ??
      session?.dialogues[0]?.dialogueId ??
      null
    if (target !== null) locate(target, true)
  }, [locate, selectedDialogueIdRef, session])

  const retrySavedLocate = useCallback(() => {
    const target =
      previewUpdateNotice?.dialogueId ??
      selectedDialogueIdRef.current ??
      session?.dialogues[0]?.dialogueId ??
      null
    if (target !== null) locate(target, true)
  }, [locate, previewUpdateNotice, selectedDialogueIdRef, session])

  const adoptRuntimeGeneration = useCallback((runtimeGeneration: number) => {
    generationRef.current = runtimeGeneration
  }, [])

  const acknowledgeSaved = useCallback((edits: readonly DialogueTextEditDTO[]) => {
    for (const edit of edits) sentDraftIdsRef.current.delete(edit.dialogueId)
  }, [])

  const applyPreviewUpdate = useCallback(
    (update: PreviewUpdateVO, dialogueId: string | null) => {
      if (update.status === 'kept') {
        applyRuntimeStage(update.stage, false)
        setPreviewUpdateNotice(null)
        return
      }
      if (update.status === 'failed') {
        phaseRef.current = 'unknown'
        positionRef.current = { kind: 'unknown' }
        setPhase('unknown')
        setPosition(positionRef.current)
      }
      const targetNumber =
        dialogueId === null ? null : dialogueNumber(sessionRef.current?.dialogues ?? [], dialogueId)
      const copy = previewUpdateCopy(update, targetNumber)
      setPreviewUpdateNotice({
        tone: copy.tone,
        message: copy.message,
        action: copy.action,
        dialogueId
      })
    },
    [applyRuntimeStage]
  )

  const showSettlementSyncNotice = useCallback((dialogueId: string | null) => {
    if (stageRef.current.status !== 'ready') return
    const targetNumber =
      dialogueId === null ? null : dialogueNumber(sessionRef.current?.dialogues ?? [], dialogueId)
    const target = targetNumber === null ? '目标台词' : `第 ${targetNumber} 句`
    setPreviewUpdateNotice({
      tone: 'warning',
      message: `保存已核对。预览还没有同步到${target}，重新打开预览可以恢复。`,
      action: 'reopen',
      dialogueId
    })
  }, [])

  const clearPreviewUpdateNotice = useCallback(() => {
    setPreviewUpdateNotice(null)
  }, [])

  const waitForIdle = useCallback(async (): Promise<void> => {
    await queueRef.current
  }, [])

  const resetStage = useCallback(() => {
    queueTokenRef.current += 1
    locateTokenRef.current += 1
    workCountRef.current = 0
    queueRef.current = Promise.resolve()
    clearDraftTimer()
    pendingDraftRef.current = null
    draftRevisionRef.current = 0
    sentDraftIdsRef.current.clear()
    preparedSessionRef.current = null
    generationRef.current = 0
    stageRef.current = { status: 'idle' }
    phaseRef.current = 'unknown'
    positionRef.current = { kind: 'unknown' }
    setStage({ status: 'idle' })
    setPhase('unknown')
    setPosition(positionRef.current)
    setStageBusy(false)
    setIframeLoaded(false)
    setStartupPending(false)
    setFrameToken((value) => value + 1)
    setControlsBlockedReason(null)
    setLocateFailure(null)
    setPreviewUpdateNotice(null)
    setDraftNotice(null)
    setSubscriptionNotice(null)
  }, [clearDraftTimer])

  useEffect(() => {
    return () => {
      queueTokenRef.current += 1
      locateTokenRef.current += 1
      if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current)
    }
  }, [])

  const dialogues = session?.dialogues ?? []
  const positionIndex =
    position.kind === 'dialogue'
      ? dialogues.findIndex((dialogue) => dialogue.dialogueId === position.dialogueId)
      : -1
  const controlsUsable = stage.status === 'ready' && controlsBlockedReason === null
  const canPrevious = controlsUsable && !stageBusy && positionIndex > 0
  const canNext =
    controlsUsable && !stageBusy && positionIndex >= 0 && positionIndex < dialogues.length - 1

  return {
    stage,
    phase,
    position,
    stageBusy,
    iframeLoaded,
    startupPending,
    frameToken,
    controlsBlockedReason,
    locateFailure,
    previewUpdateNotice,
    draftNotice,
    subscriptionNotice,
    canPrevious,
    canNext,
    onStageLoad,
    reloadFrame,
    prepareAgain,
    locateDialogue: (dialogueId: string) => locate(dialogueId, true),
    retryLocate,
    retrySavedLocate,
    previousDialogue: () => stepDialogue(-1),
    nextDialogue: () => stepDialogue(1),
    replayScene,
    scheduleDraft,
    flushDraft,
    waitForIdle,
    adoptRuntimeGeneration,
    acknowledgeSaved,
    applyPreviewUpdate,
    showSettlementSyncNotice,
    clearPreviewUpdateNotice,
    resetStage
  }
}
