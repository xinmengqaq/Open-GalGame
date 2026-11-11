import { useCallback, type ReactElement, type ReactNode } from 'react'

import type { SaveStatusView } from '@presentation/features/workbench-session/workbenchSaveStatus'
import { BackIcon } from '../WorkbenchIcons'
import { ToolbarActions } from './ToolbarActions'
import type { WorkbenchToolbarAction } from './workbenchActions'
import type { RegisterWorkbenchInset } from './workbenchLayout'
import styles from './workbenchShell.module.css'

interface WorkbenchToolbarProps {
  projectName: string
  sceneLabel: string
  statusSlot: ReactNode
  actions: readonly WorkbenchToolbarAction[]
  compact: boolean
  saveStatus: SaveStatusView
  taskStatus?: ReactNode
  registerInset: RegisterWorkbenchInset
  onBack: () => void
}

/** 顶栏四个槽位：返回、身份、状态、动作。身份与动作不混排。 */
export function WorkbenchToolbar({
  projectName,
  sceneLabel,
  statusSlot,
  actions,
  compact,
  saveStatus,
  taskStatus,
  registerInset,
  onBack
}: WorkbenchToolbarProps): ReactElement {
  const registerTopBar = useCallback(
    (node: HTMLElement | null) => registerInset('topBar', node),
    [registerInset]
  )

  return (
    <header ref={registerTopBar} className={styles.topbar} data-motion="chrome">
      <button
        type="button"
        className={styles.back}
        onClick={onBack}
        aria-label="返回项目页"
        title="返回项目页"
      >
        <BackIcon />
      </button>

      <div className={styles.identity}>
        <p className={styles.kicker}>工作台 · 场景画布</p>
        <div className={styles.identityLine}>
          <p className={styles.project} title={projectName}>
            {projectName}
          </p>
          <span className={styles.sceneChip}>{sceneLabel}</span>
        </div>
      </div>

      <div className={styles.stateSlot}>{statusSlot}</div>

      <div className={styles.actionSlotWrap}>
        <ToolbarActions
          actions={actions}
          compact={compact}
          saveStatus={saveStatus}
          taskStatus={taskStatus}
        />
      </div>
    </header>
  )
}
