import type {
  VersionContentSource,
  VersionSaveMode
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { VersionHistoryEntryVO } from '@application/project-versioning/vo/VersionHistoryVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export type HistoryFilter = 'all' | VersionSaveMode

export type HistoryListItem =
  | { kind: 'entry'; entry: VersionHistoryEntryVO }
  | {
      kind: 'systemGroup'
      groupId: string
      entries: readonly VersionHistoryEntryVO[]
    }

/** 同一天的记录归入一个日期章节；自动保存组按首条记录的日期归属。 */
export type HistoryDaySection = {
  key: string
  label: string
  items: HistoryListItem[]
}

export type HistoryActionFailure = {
  kind: 'undo' | 'clear'
  msg: string
  conflict: boolean
  unverified: boolean
}

export type HistoryActionResult = {
  kind: 'undo' | 'clear'
  count: number
  detail: string
}

export const historyFilters: readonly { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'manual', label: '手动保存' },
  { value: 'system', label: '自动保存' }
]

export const historyFeedback = {
  title: '历史记录',
  empty: '还没有历史记录',
  loadFailed: '历史记录读取失败',
  moreFailed: '更早的记录没有读取出来',
  retry: '重新读取',
  loadMore: '加载更多',
  loading: '正在读取历史记录',
  loadingMore: '正在读取更早的记录',
  loadedCount: (count: number) => `已加载 ${count} 条`,
  noSelection: '选择一条记录查看详情',
  manual: '手动保存',
  system: '自动保存',
  ai: 'AI 生成',
  reverted: '已回退',
  undo: '撤销这次操作',
  clearEntry: '清理此条',
  clearEntryAction: '清理历史',
  clearManualBefore: '清理此条及更早的手动保存',
  clearSystemBefore: '清理此条及更早的自动保存',
  clearCategoryAction: '清理此条及更早',
  cannotUndo: '这次记录不能撤销',
  undoConfirmTitle: '撤销这次操作',
  undoConfirmLead: '只撤销这一条记录对应的操作，不恢复任意旧版本。',
  undoConflictNote: '目标已有后续修改时，撤销会被拒绝，不会覆盖你的改动。',
  undoDraftNote: '当前未保存的编辑会先保留为本会话草稿，再执行撤销。',
  undoConfirmAction: '撤销这次操作',
  undoRunning: '正在撤销',
  undoDone: '撤销完成',
  undoConflict: '未撤销，目标已有后续改动。',
  undoUnverified: '撤销结果待核对，请重新读取历史后再决定。',
  undoFailed: '撤销没有完成，请稍后重试。',
  draftFailed: '未能保留当前编辑，撤销没有执行。',
  clearEntryTitle: '清理这条历史记录',
  clearEntryLead: '只清理这条历史记录，不删除当前工程内容。',
  clearCategoryTitle: (mode: VersionSaveMode) =>
    mode === 'manual' ? '清理此条及更早的手动保存' : '清理此条及更早的自动保存',
  clearCategoryLead: '清理范围包含所选记录及更早的同类记录。',
  clearCategoryUnknownPage: '范围可能包含当前尚未加载的更早记录。',
  clearCategoryAfter: '边界之后的记录，以及确认后新增的记录，不受影响。',
  clearCategoryCount: '实际清理数量以完成结果为准。',
  clearCategoryContent: '清理历史不改变当前作品内容，也不删除底层仍受保护的操作记录。',
  clearRunning: '正在清理',
  clearDone: '清理完成',
  clearCategoryDetail: (mode: VersionSaveMode) =>
    mode === 'manual' ? '手动保存 · 此条及更早' : '自动保存 · 此条及更早',
  clearFailed: '清理没有完成，请稍后重试。',
  close: '关闭',
  blockedSaving: '保存正在执行，暂不能撤销或清理。',
  blockedUnverified: '提交结果待核对，暂不能撤销或清理。',
  blockedPage: '页面当前被阻断，暂不能撤销或清理。',
  blockedStale: '正在重新读取撤销后的视图，暂不能继续操作。',
  recoverTitle: '已保留撤销前的编辑',
  restoreDraft: '恢复草稿',
  discardDraft: '丢弃草稿',
  restoreBlockedDirty: '当前还有未保存的新编辑；先保存或撤销这些编辑，再恢复草稿。',
  restoreBlockedStale: '正在重新读取撤销后的视图，完成后即可恢复草稿。',
  staleTitle: '撤销已完成，正在重新读取视图…'
} as const

const dayMs = 24 * 60 * 60 * 1000
const historyTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})
const historyMonthDay = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric'
})
const historyFullDay = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
})

/** 连续自动保存折叠成一组，手动保存各自成条。 */
export function groupHistory(entries: readonly VersionHistoryEntryVO[]): HistoryListItem[] {
  const items: HistoryListItem[] = []
  let run: VersionHistoryEntryVO[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) {
      items.push({ kind: 'entry', entry: run[0] })
    } else {
      items.push({
        kind: 'systemGroup',
        groupId: `system-${run[0].historyId}-${run.at(-1)?.historyId ?? ''}`,
        entries: run
      })
    }
    run = []
  }
  for (const entry of entries) {
    if (entry.saveMode === 'system') {
      run.push(entry)
      continue
    }
    flush()
    items.push({ kind: 'entry', entry })
  }
  flush()
  return items
}

/** 本机日历日键，用于日期章节分组。 */
export function historyDayKey(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 日期章节标题：今天、昨天、月日或年月日。 */
export function historyDayLabel(value: string, now = new Date()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= startOfToday) return '今天'
  if (date.getTime() >= startOfToday - dayMs) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return historyMonthDay.format(date)
  return historyFullDay.format(date)
}

/** 按后端顺序插入日期章节，不重排记录；连续自动保存在章节内折叠。 */
export function groupHistoryByDay(
  entries: readonly VersionHistoryEntryVO[],
  now = new Date()
): HistoryDaySection[] {
  const sections: HistoryDaySection[] = []
  for (const item of groupHistory(entries)) {
    const first = item.kind === 'entry' ? item.entry : item.entries[0]
    const key = historyDayKey(first.createdAt)
    let section = sections.at(-1)
    if (!section || section.key !== key) {
      section = { key, label: historyDayLabel(first.createdAt, now), items: [] }
      sections.push(section)
    }
    section.items.push(item)
  }
  return sections
}

/** 来源模块只给用户看中文名，不回显内部模块标识。 */
export function sourceModuleLabel(sourceModule: string): string {
  switch (sourceModule) {
    case 'scene-canvas':
      return '场景画布'
    case 'scene-canvas-auto':
      return '场景画布 · 自动编排'
    case 'project-files':
      return '工程文件'
    case 'scene-generation':
      return '场景生成'
    case 'input-catalog':
      return '输入目录'
    default:
      return '工程操作'
  }
}

export function contentSourceLabel(source: VersionContentSource): string {
  return source === 'ai' ? historyFeedback.ai : '手工操作'
}

/** 时间线行内只显示时分，日期由章节标题承担。 */
export function formatHistoryClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return historyTime.format(date)
}

/** 记录时间。今天和昨天用相对日，其他日期给出月日和时分。 */
export function formatHistoryTime(value: string, now = new Date()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const time = historyTime.format(date)
  if (date.getTime() >= startOfToday) return `今天 ${time}`
  if (date.getTime() >= startOfToday - dayMs) return `昨天 ${time}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${historyMonthDay.format(date)} ${time}`
  }
  return `${historyFullDay.format(date)} ${time}`
}

/** 自动保存组的时间范围。 */
export function formatHistoryRange(
  entries: readonly VersionHistoryEntryVO[],
  now = new Date()
): string {
  if (entries.length === 0) return ''
  const newest = formatHistoryTime(entries[0].createdAt, now)
  const oldest = formatHistoryTime(entries.at(-1)?.createdAt ?? entries[0].createdAt, now)
  return newest === oldest ? newest : `${oldest} — ${newest}`
}

export function saveModeLabel(mode: VersionSaveMode): string {
  return mode === 'manual' ? historyFeedback.manual : historyFeedback.system
}

/** 结果反馈必须带动作名和数量；详情只作补充。 */
export function historyResultMessage(result: HistoryActionResult): string {
  if (result.kind === 'undo') {
    return `已撤销 ${result.count} 条记录 · ${result.detail}`
  }
  return `已清理 ${result.count} 条历史记录 · ${result.detail}`
}

/** 清理成功后先从已加载记录移除已确认清除的范围，后续再读取第一页。 */
export function removeClearedEntries(
  entries: readonly VersionHistoryEntryVO[],
  selection:
    | { kind: 'entry'; historyId: string }
    | {
        kind: 'category'
        saveMode: VersionSaveMode
        throughHistoryId: string
        contentSource?: 'operation' | 'ai'
      }
): VersionHistoryEntryVO[] {
  if (selection.kind === 'entry') {
    return entries.filter((entry) => entry.historyId !== selection.historyId)
  }
  const boundary = entries.findIndex((entry) => entry.historyId === selection.throughHistoryId)
  if (boundary < 0) return [...entries]
  return entries.filter(
    (entry, index) =>
      index < boundary ||
      entry.saveMode !== selection.saveMode ||
      (selection.contentSource !== undefined && entry.contentSource !== selection.contentSource)
  )
}

export function isUnverifiedFailure(code: number): boolean {
  return code === ErrorCodes.communicationFailed || code === 5308
}

export function isConflictFailure(code: number): boolean {
  return code === ErrorCodes.operationConflict
}

export function undoBlockedReason(input: {
  saveState: string
  pageBlocked: boolean
}): string | null {
  if (input.pageBlocked) return historyFeedback.blockedPage
  if (input.saveState === 'saving') return historyFeedback.blockedSaving
  if (input.saveState === 'unverified') return historyFeedback.blockedUnverified
  return null
}
