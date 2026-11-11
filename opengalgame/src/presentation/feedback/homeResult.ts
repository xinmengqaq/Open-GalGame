import { PROJECT_WORKSPACE_NOT_READY_CODE } from './workbenchFeedback'

export type HomeField = 'name' | 'synopsis'

export type HomeFailureAction = 'retry-registration' | 'rebuild-workspace' | 'none'

/** 工作区未就绪时只显示安全说明和重新构建，不显示内部路径或原始消息。 */
export const homeWorkspaceFailure = {
  title: '工程初始化未完成',
  detail: '重新构建会补齐缺失内容，不会删除已有作品。',
  action: '重新构建',
  rebuilding: '正在重新构建…'
} as const

/**
 * 把数字码映射到表单字段。无法对应字段时返回 null，改走状态卡。
 * @returns 字段名或 null。
 */
export function fieldForErrorCode(code: number): HomeField | null {
  if (code === 1101 || code === 1102) return 'name'
  if (code === 1103) return 'synopsis'
  return null
}

/**
 * 首页失败卡的主操作：1306 重试登记，1309 重新构建，其余只展示说明。
 * @returns 主操作类型。
 */
export function homeFailureAction(code: number): HomeFailureAction {
  if (code === 1306) return 'retry-registration'
  if (code === PROJECT_WORKSPACE_NOT_READY_CODE) return 'rebuild-workspace'
  return 'none'
}

/**
 * 失败响应若仍带有工程身份，用重新构建直接打开该工程；取不到时不猜测。
 * @returns 工程标识或 null。
 */
export function workspaceProjectIdFrom(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('projectId' in value)) return null
  const projectId = value.projectId
  if (typeof projectId !== 'string') return null
  const trimmed = projectId.trim()
  return trimmed === '' || trimmed !== projectId ? null : projectId
}
