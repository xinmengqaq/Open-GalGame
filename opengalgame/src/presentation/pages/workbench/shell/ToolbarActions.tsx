import { useId, type ReactElement } from 'react'

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
}

export function ToolbarActions({
  actions,
  compact,
  saveStatus
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

function SceneTool({ action }: { action: WorkbenchToolbarAction }): ReactElement {
  const hintId = useId()
  const hint = action.hint?.trim() ?? ''
  const showsHint = action.disabled === true && hint !== ''

  return (
    <span
      className={styles.sceneToolWrap}
      data-hint={showsHint ? 'true' : undefined}
      data-labeled={action.showLabel ? 'true' : undefined}
      title={showsHint ? undefined : action.hint}
      tabIndex={showsHint ? 0 : undefined}
      aria-describedby={showsHint ? hintId : undefined}
    >
      <button
        type="button"
        className={styles.sceneTool}
        data-action={action.id}
        data-labeled={action.showLabel ? 'true' : undefined}
        aria-label={action.label}
        aria-describedby={showsHint ? hintId : undefined}
        disabled={action.disabled}
        title={showsHint ? action.hint : undefined}
        onClick={action.onInvoke}
      >
        <span className={styles.sceneToolIcon} aria-hidden="true">
          {action.icon}
        </span>
        {action.showLabel ? (
          <span className={styles.sceneToolLabel} aria-hidden="true">
            {action.label}
          </span>
        ) : null}
      </button>
      {showsHint ? (
        <span id={hintId} role="tooltip" className={styles.sceneToolHint}>
          {action.hint}
        </span>
      ) : null}
    </span>
  )
}

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
