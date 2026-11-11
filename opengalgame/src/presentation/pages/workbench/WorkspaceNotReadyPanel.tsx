import { useRef, type ReactElement } from 'react'

import { useWorkspaceNotReadyMotion } from './useWorkspaceNotReadyMotion'
import styles from './WorkspaceNotReadyPanel.module.css'

interface WorkspaceNotReadyPanelProps {
  rebuilding: boolean
  failed: boolean
  onRebuild: () => void
}

/**
 * 工程工作区未就绪。只给出通用说明和一个重新构建入口，
 * 不展示路径、版本状态、锁内容或内部错误。
 */
export function WorkspaceNotReadyPanel({
  rebuilding,
  failed,
  onRebuild
}: WorkspaceNotReadyPanelProps): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  useWorkspaceNotReadyMotion(root, failed ? 'failed' : rebuilding ? 'rebuilding' : 'idle')

  return (
    <div
      ref={root}
      className={styles.panel}
      data-state={failed ? 'failed' : rebuilding ? 'rebuilding' : 'idle'}
      data-testid="workspace-not-ready"
      role="status"
    >
      <span className={styles.glow} aria-hidden="true" />
      <div className={styles.art} data-motion="layers" aria-hidden="true">
        <span className={styles.missing} data-motion="missing" />
        <svg className={styles.layers} viewBox="0 0 240 168">
          <g className={styles.back}>
            <rect x="34" y="28" width="132" height="86" rx="16" />
            <path d="M52 52h64M52 68h42" />
          </g>
          <g className={styles.middle}>
            <rect x="62" y="48" width="132" height="86" rx="16" />
            <path d="M80 72h70M80 88h46" />
          </g>
          <g className={styles.front}>
            <rect x="90" y="70" width="118" height="72" rx="16" />
            <path d="M108 96h58" />
            <path d="M132 112h18" />
          </g>
        </svg>
      </div>
      <div className={styles.copy} data-motion="copy">
        <h2>工程还没准备好</h2>
        <p>重新构建会补齐缺失的工程内容，不会删除已有作品。</p>
      </div>
      {failed ? (
        <p className={styles.failure} data-motion="failure" role="alert">
          重新构建没有完成，请稍后再试。
        </p>
      ) : (
        <p className={styles.failureSlot} aria-hidden="true" />
      )}
      <button
        className={styles.rebuild}
        data-motion="action"
        type="button"
        disabled={rebuilding}
        aria-busy={rebuilding}
        onClick={onRebuild}
      >
        <span className={styles.mark} aria-hidden="true" />
        {rebuilding ? '正在重新构建' : '重新构建'}
      </button>
    </div>
  )
}
