import { useId, type ReactElement, type ReactNode } from 'react'

import type {
  SaveStatusTone,
  SaveStatusView
} from '@presentation/features/workbench-session/workbenchSaveStatus'
import { MoreActionsMenu } from './MoreActionsMenu'
import type { WorkbenchToolbarAction } from './workbenchActions'
import styles from './workbenchShell.module.css'

interface ToolbarActionsProps {
  actions: readonly WorkbenchToolbarAction[]
  compact: boolean
  saveStatus: SaveStatusView
  taskStatus?: ReactNode
}

/**
 * 动作槽位只做呈现：保存固定在主操作位，场景工具用图标常驻，其余动作按空间进入更多菜单。
 * 图标按钮的 `title` 同时是可用性说明；禁用按钮不接收指针与焦点，禁用原因由包裹层
 * 承接键盘焦点，并用同一个 id 把 button、包裹层和可见 tooltip 连成一条说明。
 */
export function ToolbarActions({
  actions,
  compact,
  saveStatus,
  taskStatus
}: ToolbarActionsProps): ReactElement {
  const save = actions.find((action) => action.id === 'save')
  const sceneTools = actions.filter((action) => action.iconOnly && action.id !== 'save')
  const secondary = actions.filter((action) => !action.iconOnly && action.id !== 'save')
  const saving = saveStatus.state === 'saving'

  return (
    <div className={styles.actionSlot} data-compact={compact}>
      {compact ? (
        <MoreActionsMenu actions={secondary} />
      ) : (
        secondary.map((action) => (
          <button
            key={action.id}
            type="button"
            className={styles.secondaryAction}
            data-action={action.id}
            disabled={action.disabled}
            title={action.hint}
            onClick={action.onInvoke}
          >
            <span className={styles.actionIcon}>{action.icon}</span>
            <span className={styles.actionLabel}>{action.label}</span>
          </button>
        ))
      )}
      {sceneTools.length > 0 ? (
        <div className={styles.sceneTools} role="group" aria-label="场景工具">
          {sceneTools.map((action) => (
            <SceneTool key={action.id} action={action} />
          ))}
        </div>
      ) : null}
      {taskStatus}
      {save ? (
        <div className={styles.saveCluster} data-motion="save">
          <span
            className={styles.saveState}
            data-tone={saveStatus.tone}
            title={saveStatus.detail ?? saveStatus.label}
          >
            <SaveStateSignal tone={saveStatus.tone} />
            <span className={styles.saveStateLabel}>{saveStatus.label}</span>
          </span>
          <button
            type="button"
            className={styles.saveButton}
            data-saving={saving}
            aria-busy={saving || undefined}
            disabled={save.disabled}
            title={save.hint}
            onClick={save.onInvoke}
          >
            <span className={styles.saveIcon} aria-hidden="true">
              {saving ? <span className={styles.saveSpinner} /> : save.icon}
            </span>
            <span>{save.label}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 场景工具图标按钮。禁用且带原因时，按钮自身补 `title` 与 `aria-describedby`，
 * 包裹层承接键盘焦点，并在同一层渲染可见的 `role="tooltip"` 提示节点；
 * 可用或没有原因时保持原有「包裹层 title + 纯图标按钮」行为。
 */
function SceneTool({ action }: { action: WorkbenchToolbarAction }): ReactElement {
  const hintId = useId()
  const hint = action.hint?.trim() ?? ''
  const showsHint = action.disabled === true && hint !== ''

  return (
    <span
      className={styles.sceneToolWrap}
      data-hint={showsHint ? 'true' : undefined}
      title={showsHint ? undefined : action.hint}
      tabIndex={showsHint ? 0 : undefined}
      aria-describedby={showsHint ? hintId : undefined}
    >
      <button
        type="button"
        className={styles.sceneTool}
        data-action={action.id}
        aria-label={action.label}
        aria-describedby={showsHint ? hintId : undefined}
        disabled={action.disabled}
        title={showsHint ? action.hint : undefined}
        onClick={action.onInvoke}
      >
        <span className={styles.sceneToolIcon} aria-hidden="true">
          {action.icon}
        </span>
      </button>
      {showsHint ? (
        <span id={hintId} role="tooltip" className={styles.sceneToolHint}>
          {action.hint}
        </span>
      ) : null}
    </span>
  )
}

/** 保存状态字形：忙碌是转环，完成是勾，其余用状态点。 */
function SaveStateSignal({ tone }: { tone: SaveStatusTone }): ReactElement {
  if (tone === 'busy') return <span className={styles.saveSpinner} aria-hidden="true" />
  if (tone === 'ok') {
    return (
      <svg className={styles.saveCheck} viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3.4 8.4 2.9 2.9 6.3-6.6" />
      </svg>
    )
  }
  return <span className={styles.saveDot} aria-hidden="true" />
}
