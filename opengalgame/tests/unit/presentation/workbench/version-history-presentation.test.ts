import { describe, expect, it } from 'vitest'

import type { VersionHistoryEntryVO } from '@application/project-versioning/vo/VersionHistoryVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  formatHistoryRange,
  formatHistoryTime,
  groupHistory,
  groupHistoryByDay,
  historyFeedback,
  isUnverifiedFailure,
  removeClearedEntries,
  undoBlockedReason
} from '@presentation/pages/workbench/drawer/version-history/versionHistoryPresentation'

function entry(
  historyId: string,
  saveMode: 'manual' | 'system',
  createdAt: string,
  overrides: Partial<VersionHistoryEntryVO> = {}
): VersionHistoryEntryVO {
  return {
    historyId,
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene-canvas', id: 'canvas-1' }],
    saveMode,
    contentSource: 'operation',
    title: historyId,
    summary: '',
    createdAt,
    state: '已提交',
    canUndo: true,
    canClear: true,
    ...overrides
  }
}

describe('历史记录展示', () => {
  it('连续自动保存折叠为一组，手动保存打断分组', () => {
    const entries = [
      entry('manual-1', 'manual', '2026-10-18T10:00:00.000Z'),
      entry('system-1', 'system', '2026-10-18T09:00:00.000Z'),
      entry('system-2', 'system', '2026-10-18T08:00:00.000Z'),
      entry('manual-2', 'manual', '2026-10-18T07:00:00.000Z'),
      entry('system-3', 'system', '2026-10-18T06:00:00.000Z')
    ]
    const items = groupHistory(entries)
    expect(items.map((item) => item.kind)).toEqual(['entry', 'systemGroup', 'entry', 'entry'])
    const group = items[1]
    expect(group.kind === 'systemGroup' ? group.entries.map((item) => item.historyId) : []).toEqual(
      ['system-1', 'system-2']
    )
  })

  it('日期章节按后端顺序插入，跨天的自动保存组归入首条日期', () => {
    const now = new Date(2026, 9, 18, 12, 0, 0)
    const entries = [
      entry('manual-1', 'manual', new Date(2026, 9, 18, 10, 0).toISOString()),
      entry('system-1', 'system', new Date(2026, 9, 18, 9, 50).toISOString()),
      entry('system-2', 'system', new Date(2026, 9, 17, 23, 50).toISOString()),
      entry('manual-2', 'manual', new Date(2026, 9, 17, 22, 0).toISOString())
    ]
    const sections = groupHistoryByDay(entries, now)
    expect(sections.map((section) => section.label)).toEqual(['今天', '昨天'])
    expect(sections[0].items.map((item) => item.kind)).toEqual(['entry', 'systemGroup'])
    const group = sections[0].items[1]
    expect(group.kind === 'systemGroup' ? group.entries.map((item) => item.historyId) : []).toEqual(
      ['system-1', 'system-2']
    )
    expect(sections[1].items.map((item) => item.kind)).toEqual(['entry'])
  })

  it('今天、昨天和更早日期使用可读时间', () => {
    const now = new Date(2026, 9, 18, 12, 0, 0)
    expect(formatHistoryTime(new Date(2026, 9, 18, 10, 30).toISOString(), now)).toBe('今天 10:30')
    expect(formatHistoryTime(new Date(2026, 9, 17, 23, 5).toISOString(), now)).toBe('昨天 23:05')
    expect(formatHistoryTime(new Date(2026, 2, 5, 9, 7).toISOString(), now)).toBe('3月5日 09:07')
    expect(formatHistoryTime(new Date(2025, 11, 31, 18, 0).toISOString(), now)).toBe(
      '2025年12月31日 18:00'
    )
    expect(formatHistoryTime('not-a-date', now)).toBe('not-a-date')
  })

  it('自动保存组显示首尾时间范围', () => {
    const now = new Date(2026, 9, 18, 12, 0, 0)
    const entries = [
      entry('system-1', 'system', new Date(2026, 9, 18, 10, 30).toISOString()),
      entry('system-2', 'system', new Date(2026, 9, 18, 10, 4).toISOString())
    ]
    expect(formatHistoryRange(entries, now)).toBe('今天 10:04 — 今天 10:30')
  })

  it('清理成功只移除已加载范围内同保存方式的更早记录', () => {
    const entries = [
      entry('manual-new', 'manual', '2026-10-18T10:00:00.000Z'),
      entry('system-new', 'system', '2026-10-18T09:00:00.000Z'),
      entry('system-boundary', 'system', '2026-10-18T08:00:00.000Z'),
      entry('manual-old', 'manual', '2026-10-18T07:00:00.000Z'),
      entry('system-old', 'system', '2026-10-18T06:00:00.000Z')
    ]
    expect(
      removeClearedEntries(entries, { kind: 'entry', historyId: 'system-new' }).map(
        (item) => item.historyId
      )
    ).toEqual(['manual-new', 'system-boundary', 'manual-old', 'system-old'])
    expect(
      removeClearedEntries(entries, {
        kind: 'category',
        saveMode: 'system',
        throughHistoryId: 'system-boundary'
      }).map((item) => item.historyId)
    ).toEqual(['manual-new', 'system-new', 'manual-old'])
  })

  it('保存中、结果待核对和页面阻断给出撤销与清理的不可用原因', () => {
    expect(undoBlockedReason({ saveState: 'saving', pageBlocked: false })).toBe(
      historyFeedback.blockedSaving
    )
    expect(undoBlockedReason({ saveState: 'unverified', pageBlocked: false })).toBe(
      historyFeedback.blockedUnverified
    )
    expect(undoBlockedReason({ saveState: 'saved', pageBlocked: true })).toBe(
      historyFeedback.blockedPage
    )
    expect(undoBlockedReason({ saveState: 'dirty', pageBlocked: false })).toBeNull()
  })

  it('通信中断和证据不足都属于结果待核对', () => {
    expect(isUnverifiedFailure(ErrorCodes.communicationFailed)).toBe(true)
    expect(isUnverifiedFailure(5308)).toBe(true)
    expect(isUnverifiedFailure(ErrorCodes.operationConflict)).toBe(false)
  })
})
