import type { ReactNode } from 'react'

export type WorkbenchActionId =
  'save' | 'generate' | 'history' | 'inspect' | 'refresh' | 'preview' | 'export'

export interface WorkbenchToolbarAction {
  id: WorkbenchActionId
  label: string
  icon: ReactNode
  onInvoke: () => void
  disabled?: boolean
  hint?: string
  iconOnly?: boolean
  /** 场景工具在图标旁常驻显示标签；仍保留同一份禁用原因浮层。 */
  showLabel?: boolean
}
