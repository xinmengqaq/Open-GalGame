import { useRef, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import type { FailureState } from '../../feedback/failure'
import { RefreshIcon } from '../../pages/workbench/WorkbenchIcons'
import { catalogStateOf } from '../workbench-session/workbenchState'
import { AlertIcon } from './InputCatalogIcons'
import { useStateArtMotion } from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogFailureStateProps {
  error: FailureState
  onRetry: () => void
}

/**
 * 来源读取失败或目录内容损坏，与空目录、搜索无结果区分。
 * 标题、说明和下一步来自统一目录状态；只有可重新读取的状态才提供重试。
 */
export function InputCatalogFailureState({
  error,
  onRetry
}: InputCatalogFailureStateProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const state = catalogStateOf('failed', error)
  const reload = state.actions.find((action) => action.intent === 'reload')
  useStateArtMotion(ref)

  return (
    <div
      ref={ref}
      className={styles.state}
      data-testid="catalog-failed"
      data-kind={state.kind}
      data-tone={state.tone}
    >
      <div className={styles.failureArt} data-state-art="" aria-hidden="true">
        <span className={styles.failureRing} />
        <AlertIcon />
      </div>
      <p className={styles.stateTitle}>{state.title}</p>
      <p className={styles.stateHint}>{state.detail ?? error.msg}</p>
      {reload ? (
        <div className={styles.stateActions}>
          <Button className={styles.statePrimary} onClick={onRetry}>
            <RefreshIcon />
            {reload.label}
          </Button>
        </div>
      ) : null}
      <p className={styles.stateFootnote}>
        {reload
          ? '这是读取失败，不是空目录。重试只重新读取来源，不会改动已有文件。'
          : state.nextStep}
      </p>
    </div>
  )
}
