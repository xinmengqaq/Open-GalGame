import { toast } from 'sonner'

/** 关系动作反馈只走既有 sonner 通道，由全局反馈层统一呈现。 */
export const relationFeedback = {
  connected: () => toast.success('已建立关联，点击线上标签写关系'),
  connectSelfRejected: () => toast.error('连接未建立：不能连接到自身'),
  connectDuplicateRejected: () => toast.error('连接未建立：该关系已存在'),
  connectFailed: () => toast.error('建立关联未完成，请稍后重试'),
  recordAttached: () => toast.success('已装载为关系记录'),
  recordAttachFailed: () => toast.error('装载关系记录未完成，请稍后重试'),
  recordKindRejected: () => toast.error('装载关系记录未完成：只有文档卡或提示词卡可以装载'),
  recordInUseRejected: () =>
    toast.error('装载关系记录未完成：这张提示词已装在另一条关系上，请先复制卡片'),
  recordDetached: () => toast.success('已卸下关系记录'),
  recordDetachFailed: () => toast.error('卸下关系记录未完成，请稍后重试'),
  relationDeleted: () => toast.success('已删除连线')
} as const
