import type { ReactNode } from 'react'

export type WorkbenchActionId =
  'save' | 'generate' | 'history' | 'inspect' | 'refresh' | 'preview' | 'export'

/**
 * 顶栏全局动作的唯一注册项。保存也在同一注册表里，只固定在主操作槽位。
 * 宽区和紧凑区读同一份 id、标签、图标、禁用条件与回调，不复制业务分支。
 * `iconOnly` 只给场景工具用：图标加 tooltip 常驻右上角，不占文字按钮的位置。
 */
export interface WorkbenchToolbarAction {
  id: WorkbenchActionId
  label: string
  icon: ReactNode
  onInvoke: () => void
  disabled?: boolean
  hint?: string
  iconOnly?: boolean
}
