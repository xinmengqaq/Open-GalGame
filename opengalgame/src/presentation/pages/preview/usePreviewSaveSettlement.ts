import { useCallback, useRef, useState } from 'react'

import type { SaveDialogueChangesVO } from '@application/scene-preview/vo/DialogueSaveVO'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

import {
  failureFromError,
  settlementQueryFailureNote,
  settlementQueryOutcome,
  type PreviewFailureView,
  type PreviewSaveUiState
} from './previewPresentation'
import type { MutableRef, UsePreviewDraftEditingResult } from './usePreviewDraftEditing'
import type { UsePreviewSessionLifecycleResult } from './usePreviewSessionLifecycle'
import type { UseScenePreviewStageResult } from './useScenePreviewStage'

export type PreviewSaveOutcome = 'saved' | 'unchanged' | 'rejected' | 'pending' | 'blocked'

export type PreviewSaveNotice = {
  readonly revision: number
  readonly message: string
}

export type PreviewSavedVersion = {
  readonly requestId: string
  readonly contentBasis: SceneContentBasisVO
}

type PendingSaveRequest = {
  readonly requestId: string
  readonly previewTarget: string | null
}

interface UsePreviewSaveSettlementOptions {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
  readonly onSavedVersion?: (saved: PreviewSavedVersion) => void
  readonly draft: UsePreviewDraftEditingResult
  readonly lifecycle: UsePreviewSessionLifecycleResult
  readonly stage: UseScenePreviewStageResult
  readonly saveInFlightRef: MutableRef<boolean>
}

export interface UsePreviewSaveSettlementResult {
  readonly saveState: PreviewSaveUiState
  readonly saveNotice: PreviewSaveNotice
  readonly saveBlockedReason: string | null
  readonly save: () => Promise<PreviewSaveOutcome>
  readonly checkSettlement: () => Promise<void>
  readonly clearRejectedSave: () => void
  readonly beginOpen: () => void
  readonly markClosed: () => void
  readonly resetForSession: () => void
  readonly syncStateRefs: () => void
}

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `preview-save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function usePreviewSaveSettlement({
  client,
  projectId,
  sceneId,
  onSavedVersion,
  draft,
  lifecycle,
  stage,
  saveInFlightRef
}: UsePreviewSaveSettlementOptions): UsePreviewSaveSettlementResult {
  const [saveState, setSaveState] = useState<PreviewSaveUiState>({ status: 'idle' })
  const [saveNotice, setSaveNotice] = useState<PreviewSaveNotice>({ revision: 0, message: '' })
  const [saveBlockedReason, setSaveBlockedReason] = useState<string | null>(null)

  const saveStateRef = useRef<PreviewSaveUiState>({ status: 'idle' })
  const saveBlockedRef = useRef<string | null>(null)
  const pendingSaveRef = useRef<PendingSaveRequest | null>(null)
  const settlementInFlightRef = useRef(false)

  const {
    commitSaved,
    closeEditingState,
    finishEditing,
    selectedRef,
    baselineRef: draftBaselineRef,
    draftsRef: draftDraftsRef
  } = draft
  const { sessionRef, basisRef, lockRef, replaceBasis, markLocked } = lifecycle
  const {
    waitForIdle,
    flushDraft,
    adoptRuntimeGeneration,
    acknowledgeSaved,
    applyPreviewUpdate,
    showSettlementSyncNotice,
    clearPreviewUpdateNotice
  } = stage

  const applySaveState = useCallback((next: PreviewSaveUiState) => {
    saveStateRef.current = next
    setSaveState(next)
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
      }
      setSaveNotice((previous) => ({ revision: previous.revision + 1, message }))
    },
    [onSavedVersion]
  )

  const clearRejectedSave = useCallback(() => {
    if (saveStateRef.current.status === 'rejected') applySaveState({ status: 'idle' })
  }, [applySaveState])

  const beginOpen = useCallback(() => {
    setSaveState({ status: 'idle' })
    setSaveBlockedReason(null)
  }, [])

  const markClosed = useCallback(() => {
    setSaveState({ status: 'idle' })
  }, [])

  const resetForSession = useCallback(() => {
    pendingSaveRef.current = null
    saveInFlightRef.current = false
    settlementInFlightRef.current = false
    saveStateRef.current = { status: 'idle' }
    saveBlockedRef.current = null
    setSaveState({ status: 'idle' })
    setSaveBlockedReason(null)
  }, [])

  const syncStateRefs = useCallback(() => {
    saveStateRef.current = saveState
    saveBlockedRef.current = saveBlockedReason
  }, [saveState, saveBlockedReason])

  const save = useCallback(async (): Promise<PreviewSaveOutcome> => {
    const opened = sessionRef.current
    if (opened === null) return 'blocked'
    if (saveInFlightRef.current || pendingSaveRef.current !== null) return 'blocked'
    if (saveBlockedRef.current !== null) return 'blocked'
    if (lockRef.current !== 'editable') return 'blocked'
    const currentBaseline = draftBaselineRef.current
    const currentDrafts = draftDraftsRef.current
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
        commitSaved(result.committedEdits)
        replaceBasis(result.contentBasis)
        clearSaveBlock()
        applySaveState({ status: 'saved' })
        publishSaved(savedRequestId, result.contentBasis, '已保存')
        applyPreviewUpdate(result.previewUpdate, target)
        allowDraftResume()
        return 'saved'
      }
      if (result.status === 'unchanged') {
        closeEditingState()
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
        markLocked()
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
    applyPreviewUpdate,
    applySaveState,
    clearPreviewUpdateNotice,
    clearSaveBlock,
    client,
    closeEditingState,
    commitSaved,
    finishEditing,
    flushDraft,
    markLocked,
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
        commitSaved(settlement.committedEdits)
        replaceBasis(settlement.contentBasis)
        const target = pendingSaveRef.current?.previewTarget ?? selectedRef.current
        pendingSaveRef.current = null
        applySaveState({ status: 'saved' })
        publishSaved(pending.requestId, settlement.contentBasis, '保存已确认')
        showSettlementSyncNotice(target)
        return
      }
      if (outcome.kind === 'unchanged') {
        closeEditingState()
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
    applySaveState,
    client,
    closeEditingState,
    commitSaved,
    projectId,
    publishSaved,
    replaceBasis,
    sceneId,
    showSettlementSyncNotice
  ])

  return {
    saveState,
    saveNotice,
    saveBlockedReason,
    save,
    checkSettlement,
    clearRejectedSave,
    beginOpen,
    markClosed,
    resetForSession,
    syncStateRefs
  }
}
