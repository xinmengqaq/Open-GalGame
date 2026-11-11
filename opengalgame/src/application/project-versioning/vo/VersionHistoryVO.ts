import type { VersionContentSource, VersionSaveMode } from '../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../models/VersionTarget'

/** 一条可见的用户历史。不含路径、修订或操作身份。 */
export type VersionHistoryEntryVO = {
  historyId: string
  sourceModule: string
  targets: readonly VersionTarget[]
  saveMode: VersionSaveMode
  contentSource: VersionContentSource
  title: string
  summary: string
  createdAt: string
  state: '已提交' | '已回退'
  canUndo: boolean
  canClear: boolean
}

/** 一页用户历史。空列表不是读取失败。 */
export type VersionHistoryPageVO = {
  entries: readonly VersionHistoryEntryVO[]
  nextCursor: string | null
}

/** 对应历史条目已经回退。不返回内部修订。 */
export type VersionHistoryUndoVO = {
  historyId: string
  state: '已回退'
}

/** 实际从用户历史移除的条目数。 */
export type VersionHistoryClearVO = {
  clearedCount: number
}
