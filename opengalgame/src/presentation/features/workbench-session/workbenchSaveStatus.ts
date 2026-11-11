import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import type { WorkbenchSaveState, WorkbenchSessionState } from './workbenchSession.types'

export type SaveStatusTone = 'neutral' | 'accent' | 'busy' | 'ok' | 'warning' | 'danger'

export type SaveStatusView = {
  state: WorkbenchSaveState
  label: string
  detail: string | null
  tone: SaveStatusTone
}

const labels: Record<WorkbenchSaveState, { label: string; tone: SaveStatusTone }> = {
  idle: { label: '尚无改动', tone: 'neutral' },
  dirty: { label: '有未保存改动', tone: 'accent' },
  saving: { label: '正在保存', tone: 'busy' },
  saved: { label: '已保存', tone: 'ok' },
  unsaved: { label: '未保存', tone: 'danger' },
  committedUnsubmitted: { label: '已落盘，未提交', tone: 'warning' },
  unverified: { label: '结果待核对', tone: 'warning' },
  failed: { label: '保存失败', tone: 'danger' }
}

/** 保存状态只由真实保存结果和草稿差异决定。 */
export function saveStatusOf(
  state: Pick<WorkbenchSessionState, 'saveState' | 'saveError'>
): SaveStatusView {
  const view = labels[state.saveState]
  if (state.saveState === 'unverified') {
    return { ...view, state: state.saveState, detail: workbenchFeedback.saveUnverified }
  }
  if (state.saveState === 'committedUnsubmitted') {
    return { ...view, state: state.saveState, detail: workbenchFeedback.saveCommittedUnsubmitted }
  }
  if (state.saveState === 'unsaved') {
    return { ...view, state: state.saveState, detail: state.saveError?.msg ?? null }
  }
  if (state.saveState === 'failed') {
    return { ...view, state: state.saveState, detail: state.saveError?.msg ?? null }
  }
  return { ...view, state: state.saveState, detail: null }
}
