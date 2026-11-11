import type { ReactElement } from 'react'

import { Button } from '@presentation/components/Button'
import type { SessionSnapshot } from '@presentation/features/workbench-session/workbenchSession.types'
import { historyFeedback } from '../drawer/version-history/versionHistoryPresentation'
import { RestoreIcon } from '../WorkbenchIcons'
import styles from './VersionHistoryRecoveryBar.module.css'

interface VersionHistoryRecoveryBarProps {
  draft: SessionSnapshot | null
  canRestore: boolean
  blockedReason: string | null
  onRestore: () => void
  onDiscard: () => void
}

/**
 * 撤销成功后保留的会话草稿恢复条。它属于工作台页面壳，不放进抽屉，
 * 也不写入作品历史；样式独立于已删除的历史抽屉。
 */
export function VersionHistoryRecoveryBar({
  draft,
  canRestore,
  blockedReason,
  onRestore,
  onDiscard
}: VersionHistoryRecoveryBarProps): ReactElement | null {
  if (!draft) return null
  return (
    <div className={styles.recovery} data-motion="history-recovery" role="status">
      <span aria-hidden="true" className={styles.recoveryIcon}>
        <RestoreIcon />
      </span>
      <div className={styles.recoveryCopy}>
        <p className={styles.recoveryTitle}>{historyFeedback.recoverTitle}</p>
        {blockedReason ? <p className={styles.recoveryReason}>{blockedReason}</p> : null}
      </div>
      <div className={styles.recoveryActions}>
        <Button variant="secondary" onClick={onDiscard}>
          {historyFeedback.discardDraft}
        </Button>
        <Button disabled={!canRestore} onClick={onRestore}>
          {historyFeedback.restoreDraft}
        </Button>
      </div>
    </div>
  )
}
