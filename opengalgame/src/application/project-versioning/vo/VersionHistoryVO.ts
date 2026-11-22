import type { VersionContentSource, VersionSaveMode } from '../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../dto/VersionTarget'

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

export type VersionHistoryPageVO = {
  entries: readonly VersionHistoryEntryVO[]
  nextCursor: string | null
}

export type VersionHistoryUndoVO = {
  historyId: string
  state: '已回退'
}

export type VersionHistoryClearVO = {
  clearedCount: number
}
