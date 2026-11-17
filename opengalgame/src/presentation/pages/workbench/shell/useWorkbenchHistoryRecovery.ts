import { useCallback, useEffect, useState } from 'react'

import type { WorkbenchCommands } from '@presentation/features/workbench-session/workbenchCommands'
import { snapshotOf } from '@presentation/features/workbench-session/workbenchSessionMapper'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '@presentation/features/workbench-session/workbenchSession.store'
import type {
  SessionSnapshot,
  WorkbenchSaveState
} from '@presentation/features/workbench-session/workbenchSession.types'
import { generationHistoryBlockedReason } from '../drawer/generation/generationPresentation'
import {
  historyFeedback,
  undoBlockedReason
} from '../drawer/version-history/versionHistoryPresentation'

/** 撤销后视图重读的退避基数与上限；首轮立即重试。 */
const RETRY_BASE_DELAY_MS = 1200
const RETRY_MAX_DELAY_MS = 8000

export interface WorkbenchHistoryRecoveryOptions {
  readonly commands: WorkbenchCommands
  readonly opened: { readonly id: string } | null
  readonly reloadAfterHistoryUndo: () => Promise<boolean>
  readonly hasUnsavedEdits: boolean
  readonly saveState: WorkbenchSaveState
  readonly pageBlocked: boolean
  readonly generationActive: boolean
}

export interface WorkbenchRecoveryDraftView {
  readonly snapshot: SessionSnapshot | null
  readonly canRestore: boolean
  readonly blockedReason: string | null
  readonly restore: () => void
  readonly discard: () => void
}

export interface WorkbenchHistoryRecoveryController {
  readonly draft: WorkbenchRecoveryDraftView
  readonly viewStale: boolean
  readonly writeBlockedReason: string | null
  readonly captureDraft: () => Promise<SessionSnapshot | null>
  readonly onUndoCommitted: (draft: SessionSnapshot | null) => Promise<void>
}

/** 撤销后的页面恢复唯一所有者：会话草稿、stale 视图、重试节流与历史写阻断原因。 */
export function useWorkbenchHistoryRecovery(
  options: WorkbenchHistoryRecoveryOptions
): WorkbenchHistoryRecoveryController {
  const {
    commands,
    opened,
    reloadAfterHistoryUndo,
    hasUnsavedEdits,
    saveState,
    pageBlocked,
    generationActive
  } = options
  const [recoveryDraft, setRecoveryDraft] = useState<SessionSnapshot | null>(null)
  const [viewStale, setViewStale] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)

  const writeBlockedReason = viewStale
    ? historyFeedback.blockedStale
    : (undoBlockedReason({
        saveState,
        pageBlocked
      }) ?? (generationActive ? generationHistoryBlockedReason : null))
  const canRestoreDraft = recoveryDraft !== null && !hasUnsavedEdits && !viewStale
  const restoreBlockedReason =
    recoveryDraft === null
      ? null
      : viewStale
        ? historyFeedback.restoreBlockedStale
        : hasUnsavedEdits
          ? historyFeedback.restoreBlockedDirty
          : null

  const captureDraft = useCallback(async (): Promise<SessionSnapshot | null> => {
    if (!opened) return null
    await commands.prepareHistoryWrite()
    const state = useWorkbenchSessionStore.getState()
    if (state.projectId !== opened.id) return null
    return sessionIsDirty(state) ? snapshotOf(state) : null
  }, [commands, opened])

  const onUndoCommitted = useCallback(
    async (draft: SessionSnapshot | null): Promise<void> => {
      if (!opened) return
      if (draft) setRecoveryDraft(draft)
      setRetryNonce(0)
      setViewStale(true)
      commands.setSaveHold(true)
    },
    [commands, opened]
  )

  const retryHistoryReload = useCallback(async (): Promise<void> => {
    if (!opened) return
    const projectId = opened.id
    try {
      const reloaded = await reloadAfterHistoryUndo()
      if (useWorkbenchSessionStore.getState().projectId !== projectId) return
      if (reloaded) {
        setViewStale(false)
        commands.setSaveHold(false)
        return
      }
    } catch {}
    if (useWorkbenchSessionStore.getState().projectId !== projectId) return
    setRetryNonce((count) => count + 1)
  }, [commands, opened, reloadAfterHistoryUndo])

  useEffect(() => {
    if (!viewStale) return
    const delay =
      retryNonce === 0
        ? 0
        : Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.min(retryNonce - 1, 3), RETRY_MAX_DELAY_MS)
    const timer = setTimeout(() => void retryHistoryReload(), delay)
    return () => clearTimeout(timer)
  }, [retryHistoryReload, retryNonce, viewStale])

  const restoreDraft = useCallback((): void => {
    if (!recoveryDraft || restoreBlockedReason) return
    useWorkbenchSessionStore.getState().restoreSessionDraft(recoveryDraft)
    setRecoveryDraft(null)
  }, [recoveryDraft, restoreBlockedReason])

  const discardDraft = useCallback((): void => setRecoveryDraft(null), [])

  return {
    draft: {
      snapshot: recoveryDraft,
      canRestore: canRestoreDraft,
      blockedReason: restoreBlockedReason,
      restore: restoreDraft,
      discard: discardDraft
    },
    viewStale,
    writeBlockedReason,
    captureDraft,
    onUndoCommitted
  }
}
