import { CircleAlert, Clock3, LoaderCircle, LockKeyhole } from 'lucide-react'
import type { ReactElement } from 'react'

import { saveFailureAction, type PreviewSaveUiState } from './previewPresentation'
import styles from './PreviewSaveNotice.module.css'

interface PreviewSaveNoticeProps {
  readonly state: PreviewSaveUiState
  readonly blockedReason: string | null
  readonly canSave: boolean
  readonly onRetrySave: () => void
  readonly onReopen: () => void
  readonly onCheckSettlement: () => void
}

/** 保存失败和待确认都留在编辑任务附近，不藏进浮层。 */
export function PreviewSaveNotice({
  state,
  blockedReason,
  canSave,
  onRetrySave,
  onReopen,
  onCheckSettlement
}: PreviewSaveNoticeProps): ReactElement | null {
  if (state.status !== 'rejected' && state.status !== 'pending') {
    if (blockedReason === null) return null
    return (
      <div className={styles.notice} data-tone="blocked" role="status">
        <LockKeyhole size={16} strokeWidth={1.9} />
        <div className={styles.copy}>
          <strong>暂时不能保存</strong>
          <p>{blockedReason}</p>
        </div>
        <button type="button" className={styles.action} onClick={onReopen}>
          重新打开预览
        </button>
      </div>
    )
  }

  if (state.status === 'pending') {
    return (
      <div
        className={styles.notice}
        data-tone="pending"
        role="status"
        aria-live="polite"
        aria-busy={state.querying}
      >
        <Clock3 size={16} strokeWidth={1.9} />
        <div className={styles.copy}>
          <strong>保存结果待确认</strong>
          <p>这次保存已经受理，结果还在核对，请先不要再次保存。</p>
          {state.queryNote !== null ? <p className={styles.note}>{state.queryNote}</p> : null}
        </div>
        <button
          type="button"
          className={styles.action}
          onClick={onCheckSettlement}
          disabled={state.querying}
          aria-busy={state.querying}
        >
          {state.querying ? (
            <>
              <LoaderCircle size={12} strokeWidth={2} className={styles.spin} />
              正在查询…
            </>
          ) : (
            '查看结果'
          )}
        </button>
      </div>
    )
  }

  const action = saveFailureAction(state.failure)
  return (
    <div className={styles.notice} data-tone="error" role="alert">
      <CircleAlert size={16} strokeWidth={1.9} />
      <div className={styles.copy}>
        <strong>保存失败</strong>
        <p>{state.failure.message}</p>
      </div>
      {action === 'retry' ? (
        <button type="button" className={styles.action} onClick={onRetrySave} disabled={!canSave}>
          重试保存
        </button>
      ) : null}
      {action === 'querySettlement' ? (
        <button type="button" className={styles.action} onClick={onCheckSettlement}>
          查看结果
        </button>
      ) : null}
      {action === 'reopen' ? (
        <button type="button" className={styles.action} onClick={onReopen}>
          重新打开预览
        </button>
      ) : null}
    </div>
  )
}
