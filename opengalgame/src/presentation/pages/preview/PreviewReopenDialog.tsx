import type { ReactElement } from 'react'

import { Dialog } from '@presentation/components/Dialog'

import type { PreviewFailureView } from './previewPresentation'
import styles from './PreviewExitDialog.module.css'

interface PreviewReopenDialogProps {
  readonly open: boolean
  readonly dirtyCount: number
  readonly closing: boolean
  readonly closeError: PreviewFailureView | null
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

export function PreviewReopenDialog({
  open,
  dirtyCount,
  closing,
  closeError,
  onCancel,
  onConfirm
}: PreviewReopenDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      title="重新打开预览？"
      subtitle={dirtyCount > 0 ? '当前草稿会丢失。' : '会按最新场景重新准备舞台。'}
      size="narrow"
      allowClose={!closing}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={closing}>
            继续编辑
          </button>
          <button type="button" className={styles.primary} onClick={onConfirm} disabled={closing}>
            重新打开
          </button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.note}>
          {dirtyCount > 0
            ? '重新打开会关闭当前会话，左侧未保存的草稿不会被写回场景。'
            : '当前没有未保存的修改，重新打开只会重建舞台。'}
        </p>
        {closeError !== null ? (
          <p className={styles.alert} role="alert">
            {closeError.message}
          </p>
        ) : null}
        {closing ? <p className={styles.busy}>正在关闭当前预览…</p> : null}
      </div>
    </Dialog>
  )
}
