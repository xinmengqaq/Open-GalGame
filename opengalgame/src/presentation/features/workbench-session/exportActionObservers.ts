import type { WorkbenchActionScope } from './actionObserverScope'

/** 正式导出已成功并落盘；每次真实成功只应上报一次。 */
export type ExportedAction = {
  scope: WorkbenchActionScope
  outcome: 'confirmed'
}

/** 导出未成功；只显示原位状态，不产生成功或结束事实。 */
export type ExportFailedAction = {
  scope: WorkbenchActionScope
  outcome: 'failed'
}

export interface WorkbenchExportActionObservers {
  onExported?: (event: ExportedAction) => void
  onExportFailed?: (event: ExportFailedAction) => void
}
