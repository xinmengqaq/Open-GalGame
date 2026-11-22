import { useRef, type ReactElement } from 'react'

import type { FailureState } from '../../feedback/failure'
import { catalogStateOf } from '../workbench-session/workbenchState'
import type { WorkspaceLoadStatus } from '../workbench-session/workbenchSession.types'
import { useReadStateMotion } from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogHeaderProps {
  status: WorkspaceLoadStatus
  error: FailureState | null
}

export function InputCatalogHeader({ status, error }: InputCatalogHeaderProps): ReactElement {
  const ref = useRef<HTMLElement>(null)
  const readState = catalogStateOf(status, error)
  const stateHint = readState.detail
    ? `${readState.title}：${readState.detail} ${readState.nextStep}`
    : `${readState.title}。${readState.nextStep}`
  useReadStateMotion(ref, readState.kind)

  return (
    <header ref={ref} className={styles.header}>
      <div className={styles.headerTop}>
        <div className={styles.headerTitle}>
          <p className={styles.eyebrow}>
            <span className={styles.eyebrowDot} aria-hidden="true" />
            场景来源
          </p>
          <h2>输入目录</h2>
          <p className={styles.headerHint}>拖入画布使用，双击打开来源。</p>
        </div>
        <div className={styles.headerTools}>
          {readState.kind === 'reading' ||
          readState.kind === 'read-failed' ||
          readState.kind === 'damaged' ? (
            <span
              className={styles.readState}
              data-tone={readState.tone}
              data-read-state={readState.kind}
              data-testid="catalog-read-state"
              role="status"
              title={stateHint}
            >
              <span className={styles.readStateDot} aria-hidden="true" />
              {readState.title}
            </span>
          ) : null}
        </div>
      </div>
    </header>
  )
}
