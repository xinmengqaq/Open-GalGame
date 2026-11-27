import { useRef, type ReactElement, type ReactNode } from 'react'

import { Button } from './Button'
import { DangerAction, DangerIcon } from './DangerAction'
import { Dialog } from './Dialog'
import { useConfirmDialogMotion } from './useConfirmDialogMotion'
import styles from './ConfirmDialog.module.css'

export interface ConfirmDialogTarget {
  title: string
  meta?: ReactNode
  icon?: ReactNode
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  target?: ConfirmDialogTarget | null
  message: ReactNode
  scope?: readonly ReactNode[]
  caveat?: ReactNode
  caveatTone?: 'danger' | 'neutral'
  blockedReason?: string | null
  failure?: string | null
  confirmLabel: string
  confirmTone?: 'default' | 'danger'
  cancelLabel?: string
  busy?: boolean
  confirmDisabled?: boolean
  alternateAction?: { label: string; onClick: () => void } | null
  onConfirm: () => void
  onCancel: () => void
}

function ShieldIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4 5 7v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V7Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function ConfirmDialog({
  open,
  title,
  target,
  message,
  scope,
  caveat,
  caveatTone = 'danger',
  blockedReason,
  failure,
  confirmLabel,
  confirmTone = 'default',
  cancelLabel = '取消',
  busy = false,
  confirmDisabled = false,
  alternateAction,
  onConfirm,
  onCancel
}: ConfirmDialogProps): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const scopeItems = (scope ?? []).filter(
    (item) => item !== null && item !== undefined && item !== false
  )
  useConfirmDialogMotion(root, open)

  const actions = alternateAction ? (
    <>
      <Button
        variant="secondary"
        className={styles.safeAction}
        data-autofocus
        disabled={busy}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      <Button disabled={busy} onClick={alternateAction.onClick}>
        {alternateAction.label}
      </Button>
    </>
  ) : (
    <>
      <Button
        variant="secondary"
        className={styles.safeAction}
        data-autofocus
        disabled={busy}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      {confirmTone === 'danger' ? (
        <DangerAction
          label={confirmLabel}
          emphasis="solid"
          disabled={busy || confirmDisabled}
          onClick={onConfirm}
        />
      ) : (
        <Button disabled={busy || confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      open={open}
      title={title}
      size="narrow"
      allowClose={!busy}
      onClose={onCancel}
      actions={actions}
    >
      <div ref={root} className={styles.content}>
        {target ? (
          <div className={styles.target} data-confirm-motion="target">
            {target.icon ? (
              <span className={styles.targetIcon} aria-hidden="true">
                {target.icon}
              </span>
            ) : null}
            <span className={styles.targetCopy}>
              <span className={styles.targetTitle}>{target.title}</span>
              {target.meta ? <span className={styles.targetMeta}>{target.meta}</span> : null}
            </span>
          </div>
        ) : null}
        <p className={styles.message} data-confirm-motion="message">
          {message}
        </p>
        {scopeItems.length > 0 ? (
          <ul className={styles.scope}>
            {scopeItems.map((item, index) => (
              <li key={index} data-confirm-motion="scope">
                {item}
              </li>
            ))}
          </ul>
        ) : null}
        {caveat ? (
          <div className={styles.caveat} data-tone={caveatTone} data-confirm-motion="caveat">
            <span className={styles.caveatIcon} aria-hidden="true">
              {caveatTone === 'danger' ? <DangerIcon /> : <ShieldIcon />}
            </span>
            <p>{caveat}</p>
          </div>
        ) : null}
        {failure ? (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        ) : null}
        {blockedReason ? (
          <p className={styles.blocked} role="status">
            {blockedReason}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
