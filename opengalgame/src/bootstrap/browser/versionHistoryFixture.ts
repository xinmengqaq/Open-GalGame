import type {
  ClearVersionHistoryDTO,
  ListVersionHistoryDTO,
  UndoVersionHistoryDTO
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type {
  VersionHistoryClearVO,
  VersionHistoryEntryVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

type FixtureUndo = 'ok' | 'conflict' | 'unknown'

type FixtureEntry = VersionHistoryEntryVO & { undo: FixtureUndo }

type EntrySeed = {
  title: string
  summary: string
  saveMode: 'manual' | 'system'
  contentSource: 'operation' | 'ai'
  minutesAgo: number
  state?: '已提交' | '已回退'
  canUndo?: boolean
  canClear?: boolean
  undo?: FixtureUndo
}

const seeds: readonly EntrySeed[] = [
  {
    title: '保存场景编排',
    summary: '更新了 4 张输入卡片、1 条关联和画布视口。',
    saveMode: 'manual',
    contentSource: 'operation',
    minutesAgo: 2
  },
  {
    title: '确认生成候选',
    summary: '把屋顶对白的生成候选写入当前场景。',
    saveMode: 'manual',
    contentSource: 'ai',
    minutesAgo: 11
  },
  {
    title: '生成前自动保存',
    summary: '在启动生成前保持当前画布。',
    saveMode: 'system',
    contentSource: 'operation',
    minutesAgo: 24
  },
  {
    title: '周期自动保存',
    summary: '保持拖入人物立绘后的画布。',
    saveMode: 'system',
    contentSource: 'operation',
    minutesAgo: 27,
    undo: 'conflict'
  },
  {
    title: '周期自动保存',
    summary: '保持提示词正文的最近一次修改。',
    saveMode: 'system',
    contentSource: 'operation',
    minutesAgo: 31,
    state: '已回退',
    canUndo: false
  },
  {
    title: '生成前自动保存',
    summary: '在启动生成前保持当前画布。',
    saveMode: 'system',
    contentSource: 'operation',
    minutesAgo: 36
  },
  {
    title: '导入角色设定',
    summary: '把角色设定文档加入参考资料。',
    saveMode: 'manual',
    contentSource: 'operation',
    minutesAgo: 128,
    canUndo: false
  },
  {
    title: '调整场景背景',
    summary: '更换场景背景并更新两张图片卡片。',
    saveMode: 'manual',
    contentSource: 'ai',
    minutesAgo: 190,
    undo: 'unknown'
  },
  {
    title: '周期自动保存',
    summary: '保持画布视口与卡片位置。',
    saveMode: 'system',
    contentSource: 'operation',
    minutesAgo: 240
  },
  {
    title: '周期自动保存',
    summary: '保持画布视口与卡片位置。',
    saveMode: 'system',
    contentSource: 'operation',
    minutesAgo: 260
  },
  {
    title: '整理输入卡片',
    summary: '移动三张卡片并调整画布视口。',
    saveMode: 'manual',
    contentSource: 'operation',
    minutesAgo: 320,
    canClear: false
  }
]

const olderSeeds: readonly EntrySeed[] = Array.from({ length: 18 }, (_, index) => ({
  title: index % 3 === 0 ? '生成前自动保存' : '周期自动保存',
  summary: '保持当前画布与输入编排。',
  saveMode: 'system',
  contentSource: 'operation',
  minutesAgo: 380 + index * 17
}))

function createEntries(): FixtureEntry[] {
  const now = Date.now()
  return [...seeds, ...olderSeeds].map((seed, index) => ({
    historyId: `fixture-history-${String(index + 1).padStart(2, '0')}`,
    sourceModule: seed.saveMode === 'manual' ? 'scene-canvas' : 'scene-canvas-auto',
    targets: [{ kind: 'scene-canvas', id: 'canvas-1' }],
    saveMode: seed.saveMode,
    contentSource: seed.contentSource,
    title: seed.title,
    summary: seed.summary,
    createdAt: new Date(now - seed.minutesAgo * 60_000).toISOString(),
    state: seed.state ?? '已提交',
    canUndo: seed.canUndo ?? (seed.state !== '已回退' && seed.canClear !== false),
    canClear: seed.canClear ?? true,
    undo: seed.undo ?? 'ok'
  }))
}

function historyEntryOf(entry: FixtureEntry): VersionHistoryEntryVO {
  return {
    historyId: entry.historyId,
    sourceModule: entry.sourceModule,
    targets: entry.targets,
    saveMode: entry.saveMode,
    contentSource: entry.contentSource,
    title: entry.title,
    summary: entry.summary,
    createdAt: entry.createdAt,
    state: entry.state,
    canUndo: entry.canUndo,
    canClear: entry.canClear
  }
}

/**
 * 仅在显式验收模式使用的内存历史。默认浏览器桥仍返回不可用失败。
 * @param options - 撤销回调；empty 用于没有记录的首次保存空态。
 * @returns 三条用户历史用例的内存实现。
 */
export function createVersionHistoryFixture(options?: { onUndo?: () => void; empty?: boolean }): {
  listHistory(request: ListVersionHistoryDTO): AjaxResult<VersionHistoryPageVO>
  undoHistoryEntry(request: UndoVersionHistoryDTO): AjaxResult<VersionHistoryUndoVO>
  clearHistory(request: ClearVersionHistoryDTO): AjaxResult<VersionHistoryClearVO>
} {
  let entries: FixtureEntry[] | null = null
  const read = (): FixtureEntry[] => {
    entries ??= options?.empty === true ? [] : createEntries()
    return entries
  }

  return {
    listHistory: (request) => {
      const filtered = read().filter(
        (entry) => request.saveMode === undefined || entry.saveMode === request.saveMode
      )
      let start = 0
      if (request.cursor !== undefined) {
        const index = filtered.findIndex((entry) => entry.historyId === request.cursor)
        if (index < 0) {
          return { code: ErrorCodes.invalidRequest, msg: '历史游标不正确' }
        }
        start = index + 1
      }
      const page = filtered.slice(start, start + request.pageSize)
      const last = page.at(-1)
      return {
        code: ErrorCodes.success,
        msg: '历史记录读取完成',
        data: {
          entries: page.map(historyEntryOf),
          nextCursor: last && start + page.length < filtered.length ? last.historyId : null
        }
      }
    },
    undoHistoryEntry: (request) => {
      const entry = read().find((item) => item.historyId === request.historyId)
      if (!entry || entry.state === '已回退') {
        return { code: ErrorCodes.invalidRequest, msg: '历史条目不存在或已清理' }
      }
      if (!entry.canUndo) {
        return { code: ErrorCodes.operationConflict, msg: '目标路径已有后续修改，已拒绝回退' }
      }
      if (entry.undo === 'conflict') {
        return { code: ErrorCodes.operationConflict, msg: '目标路径已有后续修改，已拒绝回退' }
      }
      if (entry.undo === 'unknown') {
        return { code: ErrorCodes.communicationFailed, msg: '回退结果不明，不能再次回退' }
      }
      entry.state = '已回退'
      entry.canUndo = false
      options?.onUndo?.()
      return {
        code: ErrorCodes.success,
        msg: '这次操作已撤销',
        data: { historyId: entry.historyId, state: '已回退' }
      }
    },
    clearHistory: (request) => {
      const current = read()
      if (request.selection.kind === 'entry') {
        const historyId = request.selection.historyId
        const index = current.findIndex((entry) => entry.historyId === historyId)
        if (index < 0) {
          return { code: ErrorCodes.invalidRequest, msg: '历史条目不存在' }
        }
        current.splice(index, 1)
        return { code: ErrorCodes.success, msg: '历史记录已清理', data: { clearedCount: 1 } }
      }
      const selection = request.selection
      const boundary = current.findIndex((entry) => entry.historyId === selection.throughHistoryId)
      if (boundary < 0) {
        return { code: ErrorCodes.invalidRequest, msg: '历史边界不属于当前工程' }
      }
      const removed = current.filter(
        (entry, index) =>
          index >= boundary &&
          entry.saveMode === selection.saveMode &&
          (selection.sourceModule === undefined || entry.sourceModule === selection.sourceModule) &&
          (selection.contentSource === undefined || entry.contentSource === selection.contentSource)
      )
      entries = current.filter((entry) => !removed.includes(entry))
      return {
        code: ErrorCodes.success,
        msg: '历史记录已清理',
        data: { clearedCount: removed.length }
      }
    }
  }
}
