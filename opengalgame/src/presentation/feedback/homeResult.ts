import { PROJECT_WORKSPACE_NOT_READY_CODE } from './workbenchFeedback'

export type HomeField = 'name' | 'synopsis'

export type HomeFailureAction = 'retry-registration' | 'rebuild-workspace' | 'none'

export const homeWorkspaceFailure = {
  title: '工程初始化未完成',
  detail: '重新构建会补齐缺失内容，不会删除已有作品。',
  action: '重新构建',
  rebuilding: '正在重新构建…'
} as const

export function fieldForErrorCode(code: number): HomeField | null {
  if (code === 1101 || code === 1102) return 'name'
  if (code === 1103) return 'synopsis'
  return null
}

export function homeFailureAction(code: number): HomeFailureAction {
  if (code === 1306) return 'retry-registration'
  if (code === PROJECT_WORKSPACE_NOT_READY_CODE) return 'rebuild-workspace'
  return 'none'
}

export function workspaceProjectIdFrom(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('projectId' in value)) return null
  const projectId = value.projectId
  if (typeof projectId !== 'string') return null
  const trimmed = projectId.trim()
  return trimmed === '' || trimmed !== projectId ? null : projectId
}
