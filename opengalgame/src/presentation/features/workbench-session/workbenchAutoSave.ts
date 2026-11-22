import type { SceneCanvasSaveReason } from '@application/scene-canvas/dto/SceneCanvasDTO'
import { sessionIsDirty, useWorkbenchSessionStore } from './workbenchSession.store'
import type { WorkbenchSaveState } from './workbenchSession.types'

const AUTO_SAVE_DELAY_MS = 30_000

export interface WorkbenchAutoSave {
  noteLocalEdit(): void
  noteServerResult(): void
  noteSaved(): void
  noteSaveFailure(saveState: WorkbenchSaveState): void
  requestSave(reason: SceneCanvasSaveReason): Promise<void>
  setSaveHold(hold: boolean): void
  cancelScheduledSave(): void
}

interface WorkbenchAutoSaveDeps {
  enqueue<T>(task: () => Promise<T>): Promise<T>
  flushPromptEdits(): Promise<void>
  performSave(reason: SceneCanvasSaveReason): Promise<void>
}

export function createWorkbenchAutoSave(deps: WorkbenchAutoSaveDeps): WorkbenchAutoSave {
  const store = useWorkbenchSessionStore
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
  let queuedSave: Promise<void> | null = null
  let pendingSaveReason: SceneCanvasSaveReason = 'periodic'
  let manualSaveRequested = false
  let autoSaveStopped: 'none' | 'failed' | 'unverified' = 'none'
  let saveHold = false

  function clearAutoSaveTimer(): void {
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
  }

  function scheduleAutoSave(): void {
    if (saveHold || autoSaveTimer !== null || queuedSave !== null) return
    if (autoSaveStopped === 'unverified') return
    const state = store.getState()
    if (state.arrangementStatus !== 'ready' && state.arrangementStatus !== 'empty') return
    if (!sessionIsDirty(state)) return
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null
      void requestSave('periodic')
    }, AUTO_SAVE_DELAY_MS)
  }

  function noteLocalEdit(): void {
    if (autoSaveStopped === 'unverified' || saveHold) return
    autoSaveStopped = 'none'
    scheduleAutoSave()
  }

  function noteServerResult(): void {
    if (autoSaveStopped !== 'none' || saveHold) return
    scheduleAutoSave()
  }

  function noteSaved(): void {
    autoSaveStopped = 'none'
    if (sessionIsDirty(store.getState())) scheduleAutoSave()
  }

  function noteSaveFailure(saveState: WorkbenchSaveState): void {
    autoSaveStopped = saveState === 'unverified' ? 'unverified' : 'failed'
  }

  function runSave(reason: SceneCanvasSaveReason): Promise<void> {
    if (queuedSave !== null) {
      if (reason === 'manual') manualSaveRequested = true
      return queuedSave
    }
    pendingSaveReason = reason
    const run = deps.enqueue(async () => {
      const effectiveReason = manualSaveRequested ? 'manual' : pendingSaveReason
      manualSaveRequested = false
      await deps.performSave(effectiveReason)
    })
    queuedSave = run
    void run.finally(() => {
      if (queuedSave === run) queuedSave = null
      if (manualSaveRequested) {
        manualSaveRequested = false
        void requestSave('manual')
        return
      }
      if (autoSaveStopped === 'none' && sessionIsDirty(store.getState())) scheduleAutoSave()
    })
    return run
  }

  function requestSave(reason: SceneCanvasSaveReason): Promise<void> {
    if (saveHold) return Promise.resolve()
    clearAutoSaveTimer()
    if (reason === 'manual') manualSaveRequested = true
    return deps.flushPromptEdits().then(() => runSave(reason))
  }

  function setSaveHold(hold: boolean): void {
    saveHold = hold
    if (hold) {
      clearAutoSaveTimer()
      return
    }
    if (autoSaveStopped === 'none' && sessionIsDirty(store.getState())) scheduleAutoSave()
  }

  return {
    noteLocalEdit,
    noteServerResult,
    noteSaved,
    noteSaveFailure,
    requestSave,
    setSaveHold,
    cancelScheduledSave: clearAutoSaveTimer
  }
}
