import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'

import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

import { PreviewDialogueList } from './PreviewDialogueList'
import { PreviewExitDialog } from './PreviewExitDialog'
import { PreviewReopenDialog } from './PreviewReopenDialog'
import { PreviewSaveNotice } from './PreviewSaveNotice'
import { PreviewStagePanel } from './PreviewStagePanel'
import { PreviewStateScreen } from './PreviewStateScreen'
import { PreviewTopbar } from './PreviewTopbar'
import {
  blockedAvailabilityCopy,
  emptySceneCopy,
  historyHint,
  saveHintOf,
  saveStatusOf
} from './previewPresentation'
import styles from './PreviewPage.module.css'
import { usePreviewShellMotion } from './usePreviewMotion'
import { useScenePreview, type PreviewSavedVersion } from './useScenePreview'

export interface PreviewPageProps {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
  readonly projectName: string
  readonly sceneLabel: string
  readonly onExit: () => void
  readonly onSavedVersion?: (saved: PreviewSavedVersion) => void
}

/**
 * 当前场景试玩预览：左侧编辑台词正文，右侧真实 WebGAL 舞台。
 * 页面只消费用户接口层客户端；舞台准备、位置和保存结果都以真实返回为准。
 */
export function PreviewPage({
  client,
  projectId,
  sceneId,
  projectName,
  sceneLabel,
  onExit,
  onSavedVersion
}: PreviewPageProps): ReactElement {
  const preview = useScenePreview({ client, projectId, sceneId, onSavedVersion })
  const { save: savePreview, closeSession, reopen, undo, redo, canUndo, canRedo } = preview
  const previewClosing = preview.closing
  const previewSession = preview.session
  const rootRef = useRef<HTMLDivElement>(null)
  const lastSaveNotice = useRef(0)
  const [follow, setFollow] = useState(true)
  const [exitOpen, setExitOpen] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)

  const sceneName = preview.sceneName ?? sceneLabel
  const sessionContent =
    preview.session !== null
      ? preview.dialogues.length === 0
        ? 'empty'
        : 'filled'
      : preview.sessionState
  usePreviewShellMotion(
    rootRef,
    `${preview.availability.status}:${sessionContent}:${preview.session === null ? 'closed' : 'open'}`
  )

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (preview.saveNotice.revision === 0) return
    if (preview.saveNotice.revision === lastSaveNotice.current) return
    lastSaveNotice.current = preview.saveNotice.revision
    toast.success(preview.saveNotice.message)
  }, [preview.saveNotice])

  const positionDialogueId =
    preview.position.kind === 'dialogue' ? preview.position.dialogueId : null
  const previewSyncLost =
    preview.saveState.status === 'saved' &&
    preview.previewUpdateNotice !== null &&
    preview.previewUpdateNotice.tone !== 'ok'
  const saveCopy = saveStatusOf({
    state: preview.saveState,
    dirtyCount: preview.dirtyCount,
    lockState: preview.lockState,
    previewSyncLost
  })
  const saveHint = saveHintOf({
    state: preview.saveState,
    dirtyCount: preview.dirtyCount,
    blankCount: preview.blankIds.length,
    lockState: preview.lockState,
    blockedReason: preview.saveBlockedReason,
    sessionOpen: preview.session !== null
  })
  const saveDisabled =
    preview.session === null ||
    preview.lockState !== 'editable' ||
    preview.dirtyCount === 0 ||
    preview.blankIds.length > 0 ||
    preview.saveState.status === 'saving' ||
    preview.saveState.status === 'pending' ||
    preview.saveBlockedReason !== null ||
    preview.closing
  const undoHint = historyHint({
    action: 'undo',
    available: preview.canUndo,
    editing: preview.editingDialogueId !== null,
    lockState: preview.lockState,
    saveState: preview.saveState
  })
  const redoHint = historyHint({
    action: 'redo',
    available: preview.canRedo,
    editing: preview.editingDialogueId !== null,
    lockState: preview.lockState,
    saveState: preview.saveState
  })

  const closeAndExit = useCallback(async () => {
    const closed = await closeSession()
    if (closed) {
      setExitOpen(false)
      onExit()
      return
    }
    setExitOpen(true)
  }, [closeSession, onExit])

  const handleBack = useCallback(() => {
    if (previewClosing) return
    if (previewSession === null) {
      onExit()
      return
    }
    setExitOpen(true)
  }, [onExit, previewClosing, previewSession])

  const handleSaveAndLeave = useCallback(async () => {
    setExitOpen(false)
    const outcome = await savePreview()
    if (outcome !== 'saved' && outcome !== 'unchanged') return
    await closeAndExit()
  }, [closeAndExit, savePreview])

  const runReopen = useCallback(async () => {
    const reopened = await reopen()
    if (reopened) {
      setReopenOpen(false)
      setExitOpen(false)
      setFollow(true)
      return
    }
    setReopenOpen(true)
  }, [reopen])

  const requestReopen = useCallback(() => {
    if (previewClosing) return
    if (preview.dirtyCount > 0) {
      setReopenOpen(true)
      return
    }
    void runReopen()
  }, [preview.dirtyCount, previewClosing, runReopen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const target = event.target
      const typing =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      const command = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (command && !event.shiftKey && key === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (exitOpen || reopenOpen || saveDisabled) return
        void savePreview()
        return
      }
      if (typing || !command) return
      const undoShortcut = !event.shiftKey && key === 'z'
      const redoShortcut = (event.shiftKey && key === 'z') || (!event.shiftKey && key === 'y')
      if (!undoShortcut && !redoShortcut) return
      event.preventDefault()
      event.stopPropagation()
      if (exitOpen || reopenOpen) return
      if (undoShortcut && canUndo) undo()
      if (redoShortcut && canRedo) redo()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [canRedo, canUndo, exitOpen, redo, reopenOpen, saveDisabled, savePreview, undo])

  useEffect(() => {
    const onGuardKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.key !== 'Delete') return
      const target = event.target
      const typing =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      if (typing) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onGuardKeyDown, true)
    return () => window.removeEventListener('keydown', onGuardKeyDown, true)
  }, [])

  const content = ((): ReactElement => {
    if (preview.availability.status === 'checking') {
      return (
        <PreviewStateScreen
          kind="loading"
          kicker="试玩预览"
          title="正在读取预览内容"
          copy="核对当前场景是否有可读取的产物。"
        />
      )
    }
    if (preview.availability.status === 'failed') {
      return (
        <PreviewStateScreen
          kind="failed"
          kicker="试玩预览"
          title="预览内容读取失败"
          copy={preview.availability.message}
          actions={
            <>
              <button
                type="button"
                className={styles.statePrimary}
                onClick={preview.refreshAvailability}
              >
                <RefreshCw size={14} strokeWidth={1.9} />
                重新读取
              </button>
              <button type="button" className={styles.stateSecondary} onClick={onExit}>
                返回工作台
              </button>
            </>
          }
        />
      )
    }
    if (preview.availability.status === 'blocked') {
      const copy = blockedAvailabilityCopy(preview.availability.reason)
      return (
        <PreviewStateScreen
          kind="blocked"
          kicker="试玩预览"
          title={copy.title}
          copy={copy.copy}
          actions={
            <>
              <button
                type="button"
                className={styles.statePrimary}
                onClick={preview.refreshAvailability}
              >
                <RefreshCw size={14} strokeWidth={1.9} />
                重新检查
              </button>
              <button type="button" className={styles.stateSecondary} onClick={onExit}>
                返回工作台
              </button>
            </>
          }
        />
      )
    }
    if (preview.sessionState === 'failed') {
      return (
        <PreviewStateScreen
          kind="failed"
          kicker="试玩预览"
          title="预览没有打开"
          copy={preview.openFailure?.message ?? '预览没有打开，请重试。'}
          actions={
            <>
              <button type="button" className={styles.statePrimary} onClick={preview.retryOpen}>
                <RefreshCw size={14} strokeWidth={1.9} />
                重试打开
              </button>
              <button type="button" className={styles.stateSecondary} onClick={onExit}>
                返回工作台
              </button>
            </>
          }
        />
      )
    }
    if (preview.sessionState === 'opening' || preview.session === null) {
      return (
        <PreviewStateScreen
          kind="loading"
          kicker="试玩预览"
          title="正在打开预览"
          copy="读取台词并建立预览会话。"
        />
      )
    }
    if (preview.dialogues.length === 0) {
      return (
        <PreviewStateScreen
          kind="blocked"
          kicker="试玩预览"
          title={emptySceneCopy.title}
          copy={emptySceneCopy.copy}
          actions={
            <button
              type="button"
              className={styles.statePrimary}
              onClick={() => {
                void closeAndExit()
              }}
            >
              返回工作台
            </button>
          }
        />
      )
    }
    return (
      <>
        <div className={styles.scriptColumn} data-preview-motion="script">
          <PreviewDialogueList
            dialogues={preview.dialogues}
            texts={preview.texts}
            dirtyIds={preview.dirtyIds}
            blankIds={preview.blankIds}
            issues={preview.issues}
            selectedDialogueId={preview.selectedDialogueId}
            editingDialogueId={preview.editingDialogueId}
            positionDialogueId={positionDialogueId}
            phase={preview.phase}
            lockState={preview.lockState}
            followEnabled={follow}
            followAvailable={
              preview.iframeLoaded && preview.stage.status === 'ready' && !preview.startupPending
            }
            canEditDialogue={preview.canEditDialogue}
            onSelectDialogue={preview.selectDialogue}
            onStartEditing={preview.startEditing}
            onFinishEditing={preview.finishEditing}
            onChangeText={preview.updateDraft}
            onFollowOn={() => setFollow(true)}
            onFollowOff={() => setFollow(false)}
            notice={
              <PreviewSaveNotice
                state={preview.saveState}
                blockedReason={preview.saveBlockedReason}
                canSave={!saveDisabled}
                onRetrySave={() => {
                  void preview.save()
                }}
                onReopen={requestReopen}
                onCheckSettlement={() => {
                  void preview.checkSettlement()
                }}
              />
            }
          />
        </div>
        <div className={styles.stageColumn} data-preview-motion="stage">
          <PreviewStagePanel
            stage={preview.stage}
            phase={preview.phase}
            position={preview.position}
            dialogues={preview.dialogues}
            dirtyCount={preview.dirtyCount}
            stageBusy={preview.stageBusy}
            iframeLoaded={preview.iframeLoaded}
            startupPending={preview.startupPending}
            frameToken={preview.frameToken}
            controlsBlockedReason={preview.controlsBlockedReason}
            canPrevious={preview.canPrevious}
            canNext={preview.canNext}
            followEnabled={follow}
            locateFailure={preview.locateFailure}
            previewUpdateNotice={preview.previewUpdateNotice}
            draftNotice={preview.draftNotice}
            subscriptionNotice={preview.subscriptionNotice}
            onPrevious={preview.previousDialogue}
            onNext={preview.nextDialogue}
            onReplay={preview.replayScene}
            onToggleFollow={() => setFollow((value) => !value)}
            onStageLoad={preview.onStageLoad}
            onReloadFrame={preview.reloadFrame}
            onPrepareAgain={preview.prepareAgain}
            onRetryLocate={preview.retryLocate}
            onRetrySavedLocate={preview.retrySavedLocate}
            onReopen={requestReopen}
          />
        </div>
      </>
    )
  })()

  return (
    <div
      ref={rootRef}
      className={styles.page}
      role="region"
      aria-label="试玩预览"
      data-testid="preview-page"
      tabIndex={-1}
    >
      <div className={styles.wash} aria-hidden="true" />
      <div className={styles.auraLeft} aria-hidden="true" />
      <div className={styles.auraRight} aria-hidden="true" />

      <PreviewTopbar
        projectName={projectName}
        sceneName={sceneName}
        sessionOpen={preview.session !== null}
        saveLabel={saveCopy.label}
        saveTone={saveCopy.tone}
        saveDisabled={saveDisabled}
        saveHint={saveHint}
        saving={preview.saveState.status === 'saving'}
        canUndo={preview.canUndo}
        canRedo={preview.canRedo}
        undoHint={undoHint}
        redoHint={redoHint}
        closing={preview.closing}
        onBack={handleBack}
        onSave={() => {
          void preview.save()
        }}
        onUndo={preview.undo}
        onRedo={preview.redo}
      />

      <main className={styles.body}>{content}</main>

      <PreviewExitDialog
        open={exitOpen && preview.session !== null}
        dirtyCount={preview.dirtyCount}
        blankCount={preview.blankIds.length}
        pending={preview.saveState.status === 'pending'}
        closing={preview.closing}
        canSave={preview.lockState === 'editable' && preview.saveBlockedReason === null}
        closeError={preview.closeError}
        onCancel={() => setExitOpen(false)}
        onLeave={() => {
          void closeAndExit()
        }}
        onSaveAndLeave={() => {
          void handleSaveAndLeave()
        }}
      />

      <PreviewReopenDialog
        open={reopenOpen && preview.session !== null}
        dirtyCount={preview.dirtyCount}
        closing={preview.closing}
        closeError={preview.closeError}
        onCancel={() => setReopenOpen(false)}
        onConfirm={() => {
          void runReopen()
        }}
      />
    </div>
  )
}
