import type { SceneCanvasSaveReason } from '@application/scene-canvas/dto/SceneCanvasDTO'
import { sessionIsDirty, useWorkbenchSessionStore } from './workbenchSession.store'
import type { WorkbenchSaveState } from './workbenchSession.types'

const AUTO_SAVE_DELAY_MS = 30_000

export interface WorkbenchAutoSave {
  /** 本地草稿已变化：未暂停时确保存在 30 秒排程，已有计时不重置。 */
  noteLocalEdit(): void
  /** 服务端编辑已应用：无暂停时确保存在自动保存排程。 */
  noteServerResult(): void
  /** 保存成功；手动保存成功会解除结果待核对后的自动保存暂停。 */
  noteSaved(): void
  /** 保存失败；只有结果待核对会暂停后续自动保存。 */
  noteSaveFailure(saveState: WorkbenchSaveState): void
  requestSave(reason: SceneCanvasSaveReason): Promise<void>
  setSaveHold(hold: boolean): void
  /** 取消尚未到期的自动保存；不等待已入队保存。 */
  cancelScheduledSave(): void
}

interface WorkbenchAutoSaveDeps {
  enqueue<T>(task: () => Promise<T>): Promise<T>
  flushPromptEdits(): Promise<void>
  performSave(reason: SceneCanvasSaveReason): Promise<void>
}

/**
 * 保存排程与在途保存合并：首次脏数据开启 30 秒窗口，期间继续编辑不重置；
 * 手动保存可合并进在途请求并升级为下一次保存的原因。
 */
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
