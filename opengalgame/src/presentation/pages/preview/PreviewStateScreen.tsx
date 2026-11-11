import { clsx } from 'clsx'
import { CircleAlert, LoaderCircle, MonitorPlay } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

import styles from './PreviewStateScreen.module.css'

interface PreviewStateScreenProps {
  readonly kind: 'loading' | 'blocked' | 'failed'
  readonly kicker: string
  readonly title: string
  readonly copy: string
  readonly actions?: ReactNode
}

export function PreviewStateScreen({
  kind,
  kicker,
  title,
  copy,
  actions
}: PreviewStateScreenProps): ReactElement {
  const markClass =
    kind === 'loading'
      ? styles.markLoading
      : kind === 'blocked'
        ? styles.markBlocked
        : styles.markFailed
  return (
    <div
      className={styles.screen}
      data-preview-motion="state"
      data-kind={kind}
      role={kind === 'failed' ? 'alert' : 'status'}
    >
      <span className={styles.orb} aria-hidden="true" />
      <span className={clsx(styles.mark, markClass)} aria-hidden="true">
        {kind === 'loading' ? (
          <LoaderCircle size={24} strokeWidth={1.7} className={styles.spin} />
        ) : kind === 'blocked' ? (
          <MonitorPlay size={24} strokeWidth={1.7} />
        ) : (
          <CircleAlert size={24} strokeWidth={1.7} />
        )}
      </span>
      <p className={styles.kicker}>{kicker}</p>
      <h2>{title}</h2>
      <p className={styles.copy}>{copy}</p>
      {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  )
}
