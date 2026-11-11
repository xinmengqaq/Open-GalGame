import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SaveDialogueChangesVO } from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewPhase,
  PreviewPositionVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type {
  SceneContentBasisVO,
  SceneDialogueVO,
  ScenePreviewIssueVO,
  ScenePreviewLockState,
  ScenePreviewSessionVO
} from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

import {
  blankDraftIdsOf,
  closePreviewDraftEditing,
  commitPreviewDraftSave,
  createPreviewDraftState,
  dirtyDraftIdsOf,
  draftTextsOf,
  editPreviewDraft,
  redoPreviewDraft,
  undoPreviewDraft,
  type PreviewDraftHistoryStep,
  type PreviewDraftState
} from './previewDraftState'
import {
  failureFromError,
  settlementQueryFailureNote,
  settlementQueryOutcome,
  type PreviewFailureView,
  type PreviewSaveUiState
} from './previewPresentation'
import {
  useScenePreviewAvailability,
  type ScenePreviewAvailabilityState
} from './useScenePreviewAvailability'
import {
  useScenePreviewStage,
  type PreviewStageUiState,
  type PreviewUpdateNotice
} from './useScenePreviewStage'

export type PreviewSessionUiState = 'opening' | 'open' | 'failed'

export type PreviewSaveOutcome = 'saved' | 'unchanged' | 'rejected' | 'pending' | 'blocked'

export type PreviewSaveNotice = {
  readonly revision: number
  readonly message: string
}

export type PreviewSavedVersion = {
  readonly requestId: string
  readonly contentBasis: SceneContentBasisVO
}

interface UseScenePreviewOptions {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
  readonly onSavedVersion?: (saved: PreviewSavedVersion) => void
}

type PendingSaveRequest = {
  readonly requestId: string
  readonly previewTarget: string | null
}

export interface UseScenePreviewResult {
  readonly availability: ScenePreviewAvailabilityState
  readonly refreshAvailability: () => void
  readonly sessionState: PreviewSessionUiState
  readonly openFailure: PreviewFailureView | null
  readonly retryOpen: () => void
  readonly reopen: () => Promise<boolean>
  readonly session: ScenePreviewSessionVO | null
  readonly sceneName: string | null
  readonly lockState: ScenePreviewLockState
  readonly dialogues: readonly SceneDialogueVO[]
  readonly issues: readonly ScenePreviewIssueVO[]
  readonly texts: Readonly<Record<string, string>>
  readonly dirtyIds: readonly string[]
  readonly dirtyCount: number
  readonly blankIds: readonly string[]
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly undo: () => void
  readonly redo: () => void
  readonly selectedDialogueId: string | null
  readonly editingDialogueId: string | null
  readonly selectDialogue: (dialogueId: string) => void
  readonly startEditing: (dialogueId: string) => void
  readonly finishEditing: () => void
  readonly updateDraft: (dialogueId: string, text: string) => void
  readonly canEditDialogue: (dialogueId: string) => boolean
  readonly stage: PreviewStageUiState
  readonly phase: PreviewPhase
  readonly position: PreviewPositionVO
  readonly stageBusy: boolean
  readonly iframeLoaded: boolean
  readonly startupPending: boolean
  readonly frameToken: number
  readonly controlsBlockedReason: string | null
  readonly locateFailure: PreviewFailureView | null
  readonly previewUpdateNotice: PreviewUpdateNotice | null
  readonly draftNotice: string | null
  readonly subscriptionNotice: string | null
  readonly onStageLoad: () => void
  readonly reloadFrame: () => void
  readonly prepareAgain: () => void
  readonly locateDialogue: (dialogueId: string) => void
  readonly retryLocate: () => void
  readonly retrySavedLocate: () => void
  readonly previousDialogue: () => void
  readonly nextDialogue: () => void
  readonly replayScene: () => void
  readonly canPrevious: boolean
  readonly canNext: boolean
  readonly saveState: PreviewSaveUiState
  readonly saveNotice: PreviewSaveNotice
  readonly save: () => Promise<PreviewSaveOutcome>
  readonly checkSettlement: () => Promise<void>
  readonly saveBlockedReason: string | null
  readonly closing: boolean
  readonly closeError: PreviewFailureView | null
  readonly closeSession: () => Promise<boolean>
}

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `preview-save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * 当前场景预览的会话、台词草稿和保存编排。
 * 打开、准备、订阅、草稿、定位、保存和结算都只经用户接口层客户端；
 * 这里不创建第二套播放状态，也不用计时器推进舞台。
 */
export function useScenePreview({
  client,
  projectId,
  sceneId,
  onSavedVersion
}: UseScenePreviewOptions): UseScenePreviewResult {
  const availability = useScenePreviewAvailability({ client, projectId, sceneId })
  const [openNonce, setOpenNonce] = useState(0)
  const [sessionState, setSessionState] = useState<PreviewSessionUiState>('opening')
  const [openFailure, setOpenFailure] = useState<PreviewFailureView | null>(null)
  const [session, setSession] = useState<ScenePreviewSessionVO | null>(null)
  const [contentBasis, setContentBasis] = useState<SceneContentBasisVO | null>(null)
  const [draftState, setDraftState] = useState<PreviewDraftState>(() => createPreviewDraftState([]))
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(null)
  const [editingDialogueId, setEditingDialogueId] = useState<string | null>(null)
  const [lockOverride, setLockOverride] = useState<ScenePreviewLockState | null>(null)
  const [saveState, setSaveState] = useState<PreviewSaveUiState>({ status: 'idle' })
  const [saveNotice, setSaveNotice] = useState<PreviewSaveNotice>({ revision: 0, message: '' })
  const [saveBlockedReason, setSaveBlockedReason] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<PreviewFailureView | null>(null)

  const sessionRef = useRef<ScenePreviewSessionVO | null>(null)
  const baselineRef = useRef<Record<string, string>>({})
  const draftsRef = useRef<Record<string, string>>({})
  const draftStateRef = useRef<PreviewDraftState>(draftState)
  const selectedRef = useRef<string | null>(null)
  const editingRef = useRef<string | null>(null)
  const lockRef = useRef<ScenePreviewLockState>('unknown')
  const basisRef = useRef<SceneContentBasisVO | null>(null)
  const saveStateRef = useRef<PreviewSaveUiState>({ status: 'idle' })
  const saveBlockedRef = useRef<string | null>(null)
  const openAttempt = useRef(0)
  const pendingSaveRef = useRef<PendingSaveRequest | null>(null)
  const saveInFlightRef = useRef(false)
  const settlementInFlightRef = useRef(false)
  const closingRef = useRef(false)

  const effectiveLock: ScenePreviewLockState = lockOverride ?? session?.lockState ?? 'unknown'
  const stageSession = session !== null && session.dialogues.length > 0 ? session : null

  const selectFromStage = useCallback((dialogueId: string) => {
    selectedRef.current = dialogueId
    setSelectedDialogueId(dialogueId)
  }, [])

  const stagePreview = useScenePreviewStage({
    client,
    projectId,
    sceneId,
    session: stageSession,
    selectedDialogueIdRef: selectedRef,
    draftsRef,
    baselineRef,
    saveInFlightRef,
    onSelectDialogue: selectFromStage
  })
  const {
    resetStage,
    locateDialogue,
    scheduleDraft,
    flushDraft,
    waitForIdle,
    adoptRuntimeGeneration,
    acknowledgeSaved,
    applyPreviewUpdate,
    showSettlementSyncNotice,
    clearPreviewUpdateNotice
  } = stagePreview

  useEffect(() => {
    sessionRef.current = session
    selectedRef.current = selectedDialogueId
    editingRef.current = editingDialogueId
    lockRef.current = effectiveLock
    basisRef.current = contentBasis
    saveStateRef.current = saveState
    saveBlockedRef.current = saveBlockedReason
  }, [
    session,
    selectedDialogueId,
    editingDialogueId,
    effectiveLock,
    contentBasis,
    saveState,
    saveBlockedReason
  ])

  const applyDraftState = useCallback((next: PreviewDraftState) => {
    draftStateRef.current = next
    baselineRef.current = next.baseline
    draftsRef.current = next.drafts
    setDraftState(next)
  }, [])

  const applySaveState = useCallback((next: PreviewSaveUiState) => {
    saveStateRef.current = next
    setSaveState(next)
  }, [])

  const replaceBasis = useCallback((basis: SceneContentBasisVO) => {
    basisRef.current = basis
    setContentBasis(basis)
  }, [])

  const clearSaveBlock = useCallback(() => {
    saveBlockedRef.current = null
    setSaveBlockedReason(null)
  }, [])

  const publishSaved = useCallback(
    (requestId: string, basis: SceneContentBasisVO, message: string) => {
      try {
        onSavedVersion?.({ requestId, contentBasis: basis })
      } catch {
        // 向工作台同步保存结果失败，不改变已持久保存的事实。
      }
      setSaveNotice((previous) => ({ revision: previous.revision + 1, message }))
    },
    [onSavedVersion]
  )

  const resetLocalSession = useCallback(() => {
    pendingSaveRef.current = null
    saveInFlightRef.current = false
    settlementInFlightRef.current = false
    sessionRef.current = null
    selectedRef.current = null
    editingRef.current = null
    lockRef.current = 'unknown'
    basisRef.current = null
    saveStateRef.current = { status: 'idle' }
    saveBlockedRef.current = null
    resetStage()
    applyDraftState(createPreviewDraftState([]))
    setSession(null)
    setContentBasis(null)
    setSelectedDialogueId(null)
    setEditingDialogueId(null)
    setLockOverride(null)
    setSaveState({ status: 'idle' })
    setSaveBlockedReason(null)
    setCloseError(null)
    setOpenFailure(null)
  }, [applyDraftState, resetStage])

  useEffect(() => {
    if (availability.state.status !== 'available') return
    if (sessionRef.current !== null) return
    const attempt = ++openAttempt.current
    let cancelled = false
    setSessionState('opening')
    setOpenFailure(null)
    void client
      .openPreview({ projectId, sceneId })
      .then((result) => {
        if (cancelled || attempt !== openAttempt.current) {
          if (result.code === ErrorCodes.success && result.data !== undefined) {
            void client.closePreview({ previewSessionId: result.data.previewSessionId })
          }
          return
        }
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setSessionState('failed')
          setOpenFailure({
            code: null,
            message:
              result.code === ErrorCodes.communicationFailed
                ? '没有联系上本地预览服务，请重试。'
                : '预览没有打开，请重试。',
            recovery: 'retry'
          })
          return
        }
        const opened = result.data
        const firstEditable =
          opened.dialogues.find((dialogue) => dialogue.editable) ?? opened.dialogues[0]
        sessionRef.current = opened
        basisRef.current = opened.contentBasis
        lockRef.current = opened.lockState
        selectedRef.current = firstEditable?.dialogueId ?? null
        setSession(opened)
        setContentBasis(opened.contentBasis)
        applyDraftState(createPreviewDraftState(opened.dialogues))
        setSelectedDialogueId(firstEditable?.dialogueId ?? null)
        setEditingDialogueId(null)
        setLockOverride(null)
        setSaveState({ status: 'idle' })
        setSaveBlockedReason(null)
        setCloseError(null)
        setSessionState('open')
      })
      .catch(() => {
        if (cancelled || attempt !== openAttempt.current) return
        setSessionState('failed')
        setOpenFailure({ code: null, message: '预览没有打开，请重试。', recovery: 'retry' })
      })
    return () => {
      cancelled = true
    }
  }, [applyDraftState, availability.state.status, client, openNonce, projectId, sceneId])

  useEffect(() => {
    return () => {
      const opened = sessionRef.current
      sessionRef.current = null
      if (opened !== null) {
        void client.closePreview({ previewSessionId: opened.previewSessionId })
      }
    }
  }, [client])

  const finishEditing = useCallback(() => {
    editingRef.current = null
    setEditingDialogueId(null)
    applyDraftState(closePreviewDraftEditing(draftStateRef.current))
  }, [applyDraftState])

  const canEditDialogue = useCallback(
    (dialogueId: string) => {
      if (effectiveLock !== 'editable') return false
      const dialogue = session?.dialogues.find((item) => item.dialogueId === dialogueId)
      return dialogue?.editable === true
    },
    [effectiveLock, session]
  )

  const selectDialogue = useCallback(
    (dialogueId: string) => {
      if (editingRef.current !== null && editingRef.current !== dialogueId) {
        finishEditing()
      }
      locateDialogue(dialogueId)
    },
    [finishEditing, locateDialogue]
  )

  const startEditing = useCallback(
    (dialogueId: string) => {
      if (!canEditDialogue(dialogueId)) {
        selectDialogue(dialogueId)
        return
      }
      if (editingRef.current === dialogueId) return
      finishEditing()
      editingRef.current = dialogueId
      setEditingDialogueId(dialogueId)
      locateDialogue(dialogueId)
    },
    [canEditDialogue, finishEditing, locateDialogue, selectDialogue]
  )

  const updateDraft = useCallback(
    (dialogueId: string, text: string) => {
      if (!canEditDialogue(dialogueId)) return
      applyDraftState(editPreviewDraft(draftStateRef.current, dialogueId, text))
      if (saveStateRef.current.status === 'rejected') applySaveState({ status: 'idle' })
      scheduleDraft(dialogueId, text)
    },
    [applyDraftState, applySaveState, canEditDialogue, scheduleDraft]
  )

  const applyHistoryStep = useCallback(
    (step: PreviewDraftHistoryStep, direction: 'undo' | 'redo') => {
      const entry = step.applied
      if (entry === null) return
      applyDraftState(step.state)
      if (saveStateRef.current.status === 'rejected') applySaveState({ status: 'idle' })
      scheduleDraft(entry.dialogueId, direction === 'undo' ? entry.before : entry.after)
    },
    [applyDraftState, applySaveState, scheduleDraft]
  )

  const historyBlocked =
    effectiveLock !== 'editable' ||
    saveState.status === 'saving' ||
    saveState.status === 'pending' ||
    closing ||
    editingDialogueId !== null
  const canUndo = !historyBlocked && draftState.history.undo.length > 0
  const canRedo = !historyBlocked && draftState.history.redo.length > 0

  const undo = useCallback(() => {
    if (historyBlocked || saveInFlightRef.current || closingRef.current) return
    applyHistoryStep(undoPreviewDraft(draftStateRef.current), 'undo')
  }, [applyHistoryStep, historyBlocked])

  const redo = useCallback(() => {
    if (historyBlocked || saveInFlightRef.current || closingRef.current) return
    applyHistoryStep(redoPreviewDraft(draftStateRef.current), 'redo')
  }, [applyHistoryStep, historyBlocked])

  const save = useCallback(async (): Promise<PreviewSaveOutcome> => {
    const opened = sessionRef.current
    if (opened === null) return 'blocked'
    if (saveInFlightRef.current || pendingSaveRef.current !== null) return 'blocked'
    if (saveBlockedRef.current !== null) return 'blocked'
    if (lockRef.current !== 'editable') return 'blocked'
    const currentBaseline = baselineRef.current
    const currentDrafts = draftsRef.current
    const dirty = Object.keys(currentDrafts).filter(
      (dialogueId) =>
        currentBaseline[dialogueId] !== undefined &&
        currentDrafts[dialogueId] !== currentBaseline[dialogueId]
    )
    if (dirty.length === 0) {
      applySaveState({ status: 'idle' })
      return 'unchanged'
    }
    const blank = dirty.filter((dialogueId) => (currentDrafts[dialogueId] ?? '').trim() === '')
    if (blank.length > 0) {
      applySaveState({
        status: 'rejected',
        failure: {
          code: 'invalidRequest',
          message: `有 ${blank.length} 处台词还没有文字，补上后再保存。`,
          recovery: 'none'
        }
      })
      return 'blocked'
    }
    const basis = basisRef.current
    if (basis === null) return 'blocked'

    finishEditing()
    flushDraft()
    saveInFlightRef.current = true
    const previewTarget = selectedRef.current
    const requestId = createRequestId()
    const edits = dirty.map((dialogueId) => ({
      dialogueId,
      text: currentDrafts[dialogueId] ?? ''
    }))
    applySaveState({ status: 'saving' })
    let resumeDrafts = false
    try {
      await waitForIdle()
      if (sessionRef.current?.previewSessionId !== opened.previewSessionId) {
        return 'blocked'
      }
      const result = await client.saveDialogueChanges({
        previewSessionId: opened.previewSessionId,
        requestId,
        baseContentBasis: basis,
        edits
      })
      if (result.code !== ErrorCodes.success || result.data === undefined) {
        if (result.code === ErrorCodes.communicationFailed) {
          pendingSaveRef.current = { requestId, previewTarget }
          applySaveState({
            status: 'pending',
            requestId,
            failure: {
              code: null,
              message: '保存结果未确认，请核对。',
              recovery: 'querySettlement'
            },
            querying: false,
            queryNote: null
          })
          return 'pending'
        }
        applySaveState({
          status: 'rejected',
          failure: { code: null, message: '保存没有完成，请重试。', recovery: 'retry' }
        })
        resumeDrafts = true
        return 'rejected'
      }
      return applySaveResult(result.data, previewTarget, requestId, () => {
        resumeDrafts = true
      })
    } catch {
      pendingSaveRef.current = { requestId, previewTarget }
      applySaveState({
        status: 'pending',
        requestId,
        failure: {
          code: null,
          message: '保存结果未确认，请核对。',
          recovery: 'querySettlement'
        },
        querying: false,
        queryNote: null
      })
      return 'pending'
    } finally {
      saveInFlightRef.current = false
      if (resumeDrafts) flushDraft()
    }

    function applySaveResult(
      result: SaveDialogueChangesVO,
      target: string | null,
      savedRequestId: string,
      allowDraftResume: () => void
    ): PreviewSaveOutcome {
      if (result.status === 'saved') {
        adoptRuntimeGeneration(result.runtimeGeneration)
        acknowledgeSaved(result.committedEdits)
        applyDraftState(commitPreviewDraftSave(draftStateRef.current, result.committedEdits))
        replaceBasis(result.contentBasis)
        clearSaveBlock()
        applySaveState({ status: 'saved' })
        publishSaved(savedRequestId, result.contentBasis, '已保存')
        applyPreviewUpdate(result.previewUpdate, target)
        allowDraftResume()
        return 'saved'
      }
      if (result.status === 'unchanged') {
        applyDraftState(closePreviewDraftEditing(draftStateRef.current))
        replaceBasis(result.contentBasis)
        applySaveState({ status: 'unchanged' })
        clearPreviewUpdateNotice()
        allowDraftResume()
        return 'unchanged'
      }
      if (result.status === 'pendingVerification') {
        pendingSaveRef.current = {
          requestId: result.request.requestId,
          previewTarget: target
        }
        applySaveState({
          status: 'pending',
          requestId: result.request.requestId,
          failure: failureFromError(result.failure),
          querying: false,
          queryNote: null
        })
        return 'pending'
      }
      if (result.failure.code === 'contentLocked') {
        lockRef.current = 'locked'
        setLockOverride('locked')
      }
      if (result.failure.code === 'contentBasisChanged') {
        const reason = '场景内容已经在别处变化，需要重新打开预览后再保存。'
        saveBlockedRef.current = reason
        setSaveBlockedReason(reason)
      } else {
        allowDraftResume()
      }
      applySaveState({ status: 'rejected', failure: failureFromError(result.failure) })
      return 'rejected'
    }
  }, [
    acknowledgeSaved,
    adoptRuntimeGeneration,
    applyDraftState,
    applyPreviewUpdate,
    applySaveState,
    clearPreviewUpdateNotice,
    clearSaveBlock,
    client,
    finishEditing,
    flushDraft,
    publishSaved,
    replaceBasis,
    waitForIdle
  ])

  const checkSettlement = useCallback(async () => {
    const pending = saveStateRef.current
    if (pending.status !== 'pending' || settlementInFlightRef.current) return
    settlementInFlightRef.current = true
    applySaveState({ ...pending, querying: true, queryNote: null })
    try {
      const result = await client.readDialogueSaveSettlement({
        projectId,
        sceneId,
        requestId: pending.requestId
      })
      const outcome = settlementQueryOutcome(result, new Date())
      if (outcome.kind === 'error') {
        applySaveState({
          ...pending,
          querying: false,
          queryNote: outcome.queryNote
        })
        return
      }
      if (outcome.kind === 'saved') {
        const settlement = outcome.settlement
        applyDraftState(commitPreviewDraftSave(draftStateRef.current, settlement.committedEdits))
        replaceBasis(settlement.contentBasis)
        const target = pendingSaveRef.current?.previewTarget ?? selectedRef.current
        pendingSaveRef.current = null
        applySaveState({ status: 'saved' })
        publishSaved(pending.requestId, settlement.contentBasis, '保存已确认')
        showSettlementSyncNotice(target)
        return
      }
      if (outcome.kind === 'unchanged') {
        applyDraftState(closePreviewDraftEditing(draftStateRef.current))
        replaceBasis(outcome.settlement.contentBasis)
        pendingSaveRef.current = null
        applySaveState({ status: 'unchanged' })
        return
      }
      if (outcome.kind === 'pending') {
        applySaveState({
          status: 'pending',
          requestId: pending.requestId,
          failure: failureFromError(outcome.settlement.failure),
          querying: false,
          queryNote: outcome.queryNote
        })
        return
      }
      const settlement = outcome.settlement
      pendingSaveRef.current = null
      const blockedCode =
        settlement.status === 'conflict' || settlement.status === 'notCommitted'
          ? settlement.failure.code
          : null
      if (settlement.status === 'conflict' || blockedCode === 'contentBasisChanged') {
        const reason = '保存记录与当前场景不一致，需要重新打开预览后再保存。'
        saveBlockedRef.current = reason
        setSaveBlockedReason(reason)
      }
      const failure: PreviewFailureView =
        settlement.status === 'notFound'
          ? {
              code: 'saveNotConfirmed',
              message: '没有找到这次保存记录，内容仍保留在左侧。',
              recovery: 'none'
            }
          : failureFromError(settlement.failure)
      applySaveState({ status: 'rejected', failure })
    } catch {
      applySaveState({
        ...pending,
        querying: false,
        queryNote: settlementQueryFailureNote
      })
    } finally {
      settlementInFlightRef.current = false
    }
  }, [
    applyDraftState,
    applySaveState,
    client,
    projectId,
    publishSaved,
    replaceBasis,
    sceneId,
    showSettlementSyncNotice
  ])

  const closeSession = useCallback(async (): Promise<boolean> => {
    const opened = sessionRef.current
    if (opened === null) return true
    if (closingRef.current) return false
    closingRef.current = true
    setClosing(true)
    setCloseError(null)
    try {
      const result = await client.closePreview({ previewSessionId: opened.previewSessionId })
      if (result.code !== ErrorCodes.success) {
        setCloseError({ code: null, message: '关闭预览失败，请重试。', recovery: 'retry' })
        return false
      }
      sessionRef.current = null
      resetStage()
      setSession(null)
      setContentBasis(null)
      applyDraftState(createPreviewDraftState([]))
      setSelectedDialogueId(null)
      setEditingDialogueId(null)
      setSaveState({ status: 'idle' })
      return true
    } catch {
      setCloseError({ code: null, message: '关闭预览失败，请重试。', recovery: 'retry' })
      return false
    } finally {
      closingRef.current = false
      setClosing(false)
    }
  }, [applyDraftState, client, resetStage])

  const reopen = useCallback(async (): Promise<boolean> => {
    const opened = sessionRef.current
    if (opened !== null) {
      const closed = await closeSession()
      if (!closed) return false
    }
    resetLocalSession()
    setSessionState('opening')
    setOpenNonce((value) => value + 1)
    return true
  }, [closeSession, resetLocalSession])

  const retryOpen = useCallback(() => {
    setSessionState('opening')
    setOpenFailure(null)
    setOpenNonce((value) => value + 1)
  }, [])

  const dialogues = session?.dialogues ?? []
  const issues = session?.issues ?? []
  const dirtyIds = useMemo(() => dirtyDraftIdsOf(draftState), [draftState])
  const blankIds = useMemo(() => blankDraftIdsOf(draftState, dirtyIds), [dirtyIds, draftState])
  const texts = useMemo(() => draftTextsOf(draftState), [draftState])

  return {
    availability: availability.state,
    refreshAvailability: availability.refresh,
    sessionState,
    openFailure,
    retryOpen,
    reopen,
    session,
    sceneName: session?.sceneName ?? null,
    lockState: effectiveLock,
    dialogues,
    issues,
    texts,
    dirtyIds,
    dirtyCount: dirtyIds.length,
    blankIds,
    canUndo,
    canRedo,
    undo,
    redo,
    selectedDialogueId,
    editingDialogueId,
    selectDialogue,
    startEditing,
    finishEditing,
    updateDraft,
    canEditDialogue,
    stage: stagePreview.stage,
    phase: stagePreview.phase,
    position: stagePreview.position,
    stageBusy: stagePreview.stageBusy,
    iframeLoaded: stagePreview.iframeLoaded,
    startupPending: stagePreview.startupPending,
    frameToken: stagePreview.frameToken,
    controlsBlockedReason: stagePreview.controlsBlockedReason,
    locateFailure: stagePreview.locateFailure,
    previewUpdateNotice: stagePreview.previewUpdateNotice,
    draftNotice: stagePreview.draftNotice,
    subscriptionNotice: stagePreview.subscriptionNotice,
    onStageLoad: stagePreview.onStageLoad,
    reloadFrame: stagePreview.reloadFrame,
    prepareAgain: stagePreview.prepareAgain,
    locateDialogue: stagePreview.locateDialogue,
    retryLocate: stagePreview.retryLocate,
    retrySavedLocate: stagePreview.retrySavedLocate,
    previousDialogue: stagePreview.previousDialogue,
    nextDialogue: stagePreview.nextDialogue,
    replayScene: stagePreview.replayScene,
    canPrevious: stagePreview.canPrevious,
    canNext: stagePreview.canNext,
    saveState,
    saveNotice,
    save,
    checkSettlement,
    saveBlockedReason,
    closing,
    closeError,
    closeSession
  }
}
