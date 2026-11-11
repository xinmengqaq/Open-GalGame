import type { ReactElement } from 'react'

import { Dialog } from '@presentation/components/Dialog'

import type { PreviewFailureView } from './previewPresentation'
import styles from './PreviewExitDialog.module.css'

interface PreviewExitDialogProps {
  readonly open: boolean
  readonly dirtyCount: number
  readonly blankCount: number
  readonly pending: boolean
  readonly closing: boolean
  readonly canSave: boolean
  readonly closeError: PreviewFailureView | null
  readonly onCancel: () => void
  readonly onLeave: () => void
  readonly onSaveAndLeave: () => void
}

export function PreviewExitDialog({
  open,
  dirtyCount,
  blankCount,
  pending,
  closing,
  canSave,
  closeError,
  onCancel,
  onLeave,
  onSaveAndLeave
}: PreviewExitDialogProps): ReactElement {
  const dirty = dirtyCount > 0
  const title = pending
    ? '保存结果待确认'
    : dirty
      ? `还有 ${dirtyCount} 处修改没有保存`
      : '返回工作台？'
  const subtitle = pending
    ? '离开不会撤销已受理的保存。'
    : dirty
      ? '离开后，这些修改会丢失。'
      : '当前内容都已保存。'

  const actions = pending ? (
    <>
      <button type="button" className={styles.secondary} onClick={onCancel} disabled={closing}>
        留在预览
      </button>
      <button type="button" className={styles.quietDanger} onClick={onLeave} disabled={closing}>
        仍然离开
      </button>
    </>
  ) : dirty ? (
    <>
      <button type="button" className={styles.secondary} onClick={onCancel} disabled={closing}>
        继续编辑
      </button>
      <button type="button" className={styles.quietDanger} onClick={onLeave} disabled={closing}>
        放弃并离开
      </button>
      <button
        type="button"
        className={styles.primary}
        onClick={onSaveAndLeave}
        disabled={closing || blankCount > 0 || !canSave}
        title={
          blankCount > 0 ? '有台词还没有文字，补上后再保存' : canSave ? undefined : '当前不能保存'
        }
      >
        保存并离开
      </button>
    </>
  ) : (
    <>
      <button type="button" className={styles.secondary} onClick={onCancel} disabled={closing}>
        留在预览
      </button>
      <button type="button" className={styles.primary} onClick={onLeave} disabled={closing}>
        返回工作台
      </button>
    </>
  )

  return (
    <Dialog
      open={open}
      title={title}
      subtitle={subtitle}
      size="narrow"
      allowClose={!closing}
      onClose={onCancel}
      actions={actions}
    >
      <div className={styles.body}>
        {pending ? (
          <p className={styles.note}>
            这次保存还没有核对完成。离开后不会再等待结果，下次进入预览时需要按场景当前内容重新确认。
            {dirty ? `左侧还有 ${dirtyCount} 处草稿没有保存，离开会丢失。` : ''}
          </p>
        ) : null}
        {dirty && !pending ? (
          <p className={styles.note}>先保存可以保留这些修改；放弃会直接关闭预览并丢弃左侧草稿。</p>
        ) : null}
        {blankCount > 0 ? (
          <p className={styles.warning}>有 {blankCount} 处台词还没有文字，补上后才能保存离开。</p>
        ) : null}
        {closeError !== null ? (
          <p className={styles.alert} role="alert">
            {closeError.message}
          </p>
        ) : null}
        {closing ? <p className={styles.busy}>正在关闭预览…</p> : null}
      </div>
    </Dialog>
  )
}
