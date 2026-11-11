import { clsx } from 'clsx'
import { ArrowLeft, LoaderCircle, Redo2, Save, Undo2 } from 'lucide-react'
import type { ReactElement } from 'react'

import type { PreviewStatusTone } from './previewPresentation'
import styles from './PreviewTopbar.module.css'

interface PreviewTopbarProps {
  readonly projectName: string
  readonly sceneName: string
  readonly sessionOpen: boolean
  readonly saveLabel: string
  readonly saveTone: PreviewStatusTone
  readonly saveDisabled: boolean
  readonly saveHint: string | null
  readonly saving: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly undoHint: string
  readonly redoHint: string
  readonly closing: boolean
  readonly onBack: () => void
  readonly onSave: () => void
  readonly onUndo: () => void
  readonly onRedo: () => void
}

const toneClass: Record<PreviewStatusTone, string> = {
  ok: styles.statusOk,
  dirty: styles.statusDirty,
  busy: styles.statusBusy,
  warning: styles.statusWarning,
  error: styles.statusError,
  muted: styles.statusMuted
}

export function PreviewTopbar({
  projectName,
  sceneName,
  sessionOpen,
  saveLabel,
  saveTone,
  saveDisabled,
  saveHint,
  saving,
  canUndo,
  canRedo,
  undoHint,
  redoHint,
  closing,
  onBack,
  onSave,
  onUndo,
  onRedo
}: PreviewTopbarProps): ReactElement {
  return (
    <header className={styles.topbar} data-preview-motion="header">
      <button
        type="button"
        className={styles.backButton}
        onClick={onBack}
        aria-label="返回工作台"
        title="返回工作台"
        disabled={closing}
      >
        <ArrowLeft size={18} strokeWidth={1.9} />
      </button>

      <div className={styles.identity}>
        <p className={styles.kicker}>试玩预览 · 当前场景</p>
        <div className={styles.identityLine}>
          <h1>{projectName === '' ? '当前作品' : projectName}</h1>
          <span className={styles.sceneChip} title={sceneName}>
            {sceneName}
          </span>
        </div>
      </div>

      <div className={styles.topActions}>
        {sessionOpen ? (
          <>
            <div className={styles.historyGroup} role="group" aria-label="草稿编辑历史">
              <button
                type="button"
                className={styles.historyButton}
                onClick={onUndo}
                disabled={!canUndo}
                aria-label="撤销"
                title={undoHint}
              >
                <Undo2 size={16} strokeWidth={1.9} />
              </button>
              <button
                type="button"
                className={styles.historyButton}
                onClick={onRedo}
                disabled={!canRedo}
                aria-label="重做"
                title={redoHint}
              >
                <Redo2 size={16} strokeWidth={1.9} />
              </button>
            </div>
            <span
              className={clsx(styles.saveStatus, toneClass[saveTone])}
              role="status"
              aria-live="polite"
            >
              <span className={styles.saveDot} aria-hidden="true" />
              {saveLabel}
            </span>
            <button
              type="button"
              className={styles.saveButton}
              onClick={onSave}
              disabled={saveDisabled}
              title={saveHint ?? (saveDisabled ? '没有可保存的修改' : '保存当前修改（Ctrl+S）')}
            >
              {saving ? (
                <LoaderCircle size={15} strokeWidth={2} className={styles.spin} />
              ) : (
                <Save size={15} strokeWidth={1.9} />
              )}
              {saving ? '保存中' : '保存'}
            </button>
          </>
        ) : null}
      </div>
    </header>
  )
}
