import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type {
  SceneGenerationFailureReasonVO,
  SceneGenerationHistoryBoundary,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStage
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  GenerationHistory,
  HistoryDetail
} from '@presentation/pages/workbench/drawer/generation/GenerationHistory'
import {
  historyBoundaryLabel,
  historyBoundaryTone,
  historyClock,
  historyDetailViewOf,
  historyFailureReasonLabel,
  historyFullTime,
  historyHasMore,
  historyLegacyLabel,
  historyLegacyNote,
  historyPageSize,
  historyPendingVerificationLabel,
  historyPendingVerificationStage,
  historyReadonlyNote,
  historyRowViewOf,
  historySecondTime,
  historyStageLabel,
  historyViewStateOf,
  mergeHistoryPage,
  nextHistoryCursor,
  type HistoryBoundaryTone,
  type HistoryViewState
} from '@presentation/pages/workbench/drawer/generation/generationHistoryPresentation'

const historyController = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>
}))

vi.mock('@presentation/pages/workbench/drawer/generation/useGenerationHistory', () => ({
  useGenerationHistory: () => historyController.current
}))

function summary(
  overrides: Partial<SceneGenerationHistorySummaryVO> = {}
): SceneGenerationHistorySummaryVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    checkpointId: 'checkpoint-1',
    boundary: 'started',
    stage: 'generating',
    message: '开始生成这一场。',
    createdAt: '2026-10-21T10:24:00.000Z',
    ...overrides
  }
}

function controller(items: SceneGenerationHistorySummaryVO[]): Record<string, unknown> {
  return {
    items,
    view: 'ready',
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    reload: vi.fn(),
    retry: vi.fn(),
    loadMore: vi.fn()
  }
}

function renderList(items: SceneGenerationHistorySummaryVO[]): string {
  historyController.current = controller(items)
  return renderToStaticMarkup(
    createElement(GenerationHistory, {
      client: {} as SceneGenerationClient,
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
  )
}

function renderDetail(record: SceneGenerationHistorySummaryVO): string {
  return renderToStaticMarkup(
    createElement(HistoryDetail, {
      backRef: { current: null },
      onBack: () => undefined,
      record
    })
  )
}

describe('AI 历史边界与阶段文案', () => {
  it('按真实枚举完整映射操作边界', () => {
    const expected: Record<SceneGenerationHistoryBoundary, string> = {
      started: '开始',
      candidateCreated: '候选已创建',
      waitingDecision: '等待决定',
      waitingReview: '等待审阅',
      paused: '已暂停',
      committed: '已提交',
      failed: '失败',
      cancelled: '已取消'
    }

    for (const [boundary, label] of Object.entries(expected)) {
      expect(historyBoundaryLabel(boundary as SceneGenerationHistoryBoundary)).toBe(label)
    }
  })

  it('每种边界都有稳定的视觉语义', () => {
    const expected: Record<SceneGenerationHistoryBoundary, HistoryBoundaryTone> = {
      started: 'live',
      candidateCreated: 'live',
      waitingDecision: 'wait',
      waitingReview: 'wait',
      paused: 'muted',
      committed: 'done',
      failed: 'danger',
      cancelled: 'muted'
    }

    for (const [boundary, tone] of Object.entries(expected)) {
      expect(historyBoundaryTone(boundary as SceneGenerationHistoryBoundary)).toBe(tone)
    }
  })

  it('阶段中文映射覆盖后端全部阶段', () => {
    const expected: Record<SceneGenerationRenderStage, string> = {
      readingInput: '读取输入',
      generating: '生成中',
      validating: '校验 / 修正',
      waitingReview: '等待审阅',
      committing: '提交中',
      completed: '已完成',
      failed: '生成失败',
      cancelled: '已取消',
      paused: '已暂停'
    }

    for (const [stage, label] of Object.entries(expected)) {
      expect(historyStageLabel(stage as SceneGenerationRenderStage)).toBe(label)
    }
  })

  it('失败状态和阶段不再用“未完成”冒充原因', () => {
    expect(historyBoundaryLabel('failed')).not.toBe('未完成')
    expect(historyStageLabel('failed')).not.toBe('未完成')
  })
})

describe('AI 历史失败原因与旧记录', () => {
  it('旧失败原因安全码先桥接分类，再映射成用户语言，不显示枚举或错误码', () => {
    const expected: Record<SceneGenerationFailureReasonVO, string> = {
      noInformationGain: '没有进展',
      missingCandidateWrite: '输出不完整',
      outputTruncated: '输出不完整',
      missingStructuredResult: '输出不完整',
      structuredOutput: '输出不完整',
      modelFailure: '模型暂时不可用',
      modelRejected: '要求无法继续',
      modelAccess: '连接或权限需要检查',
      contextOverflow: '输入过多',
      correctionsExhausted: '自动修正次数已用尽'
    }

    for (const [reason, label] of Object.entries(expected)) {
      const mapped = historyFailureReasonLabel(reason as SceneGenerationFailureReasonVO)
      expect(mapped).toBe(label)
      expect(mapped).not.toBe(reason)
      expect(mapped).not.toBe('未完成')
    }
  })

  it('缺失失败原因时保持 null，不补造原因', () => {
    expect(historyFailureReasonLabel(undefined)).toBeNull()
    expect(historyFailureReasonLabel(null)).toBeNull()
  })

  it('行视图只有时间、状态和摘要，不含阶段、耗时、候选或重试', () => {
    const row = historyRowViewOf(
      summary({ boundary: 'failed', stage: 'failed', message: '本次生成未完成' })
    )

    expect(row).toEqual({
      time: historyClock('2026-10-21T10:24:00.000Z'),
      status: '失败',
      tone: 'danger',
      summary: '本次生成未完成'
    })
    expect(Object.keys(row).sort()).toEqual(['status', 'summary', 'time', 'tone'])
    expect(row).not.toHaveProperty('stage')
    expect(row).not.toHaveProperty('duration')
    expect(row).not.toHaveProperty('candidate')
    expect(row).not.toHaveProperty('retry')
  })

  it('详情视图带失败原因和旧记录标记，不含耗时、候选或重试', () => {
    const view = historyDetailViewOf(
      summary({
        boundary: 'failed',
        stage: 'failed',
        message: '本次生成未完成',
        failureReason: 'modelFailure',
        legacy: true
      })
    )

    expect(view).toEqual({
      clock: historyClock('2026-10-21T10:24:00.000Z'),
      time: historyFullTime('2026-10-21T10:24:00.000Z'),
      summary: '本次生成未完成',
      boundary: '失败',
      stage: '生成失败',
      tone: 'danger',
      failureReason: '模型暂时不可用',
      legacy: true,
      legacyNote: historyLegacyNote,
      readonlyNote: historyReadonlyNote
    })
    expect(Object.keys(view).sort()).toEqual([
      'boundary',
      'clock',
      'failureReason',
      'legacy',
      'legacyNote',
      'readonlyNote',
      'stage',
      'summary',
      'time',
      'tone'
    ])
    expect(view).not.toHaveProperty('duration')
    expect(view).not.toHaveProperty('candidate')
    expect(view).not.toHaveProperty('retry')
  })

  it('旧记录缺失败原因时不补造，只保留旧记录标记', () => {
    const view = historyDetailViewOf(
      summary({ boundary: 'failed', stage: 'failed', message: '本次生成未完成', legacy: true })
    )

    expect(view.failureReason).toBeNull()
    expect(view.legacy).toBe(true)
    expect(view.legacyNote).toBe(historyLegacyNote)
  })

  it('非旧记录缺失败原因时既不补原因也不标旧记录', () => {
    const view = historyDetailViewOf(
      summary({ boundary: 'committed', stage: 'completed', message: '作品已提交' })
    )

    expect(view.failureReason).toBeNull()
    expect(view.legacy).toBe(false)
    expect(view.legacyNote).toBeNull()
  })
})

describe('AI 历史待核对中断', () => {
  const pendingMessages = ['提交结果待核对', '候选或基线冲突，需要重新核对'] as const

  it('两条固定安全摘要显示为待核对，不冒充失败', () => {
    for (const message of pendingMessages) {
      const record = summary({ boundary: 'failed', stage: 'failed', message })
      const row = historyRowViewOf(record)

      expect(row.status).toBe(historyPendingVerificationLabel)
      expect(row.tone).toBe('muted')
      expect(row.tone).not.toBe('danger')
      expect(row.summary).toBe(message)

      const view = historyDetailViewOf(record)
      expect(view.boundary).toBe(historyPendingVerificationLabel)
      expect(view.stage).toBe(historyPendingVerificationStage)
      expect(view.tone).toBe('muted')
      expect(view.failureReason).toBeNull()
      expect(view.legacy).toBe(false)
      expect(view.legacyNote).toBeNull()
      expect(view.summary).toBe(message)
    }
  })

  it('只精确匹配两条固定摘要，其他失败文案仍显示失败', () => {
    for (const message of ['提交结果待核对，请稍后重试', '候选或基线冲突']) {
      const record = summary({ boundary: 'failed', stage: 'failed', message })
      const row = historyRowViewOf(record)

      expect(row.status).toBe('失败')
      expect(row.tone).toBe('danger')
      expect(historyDetailViewOf(record).stage).toBe('生成失败')
    }
  })

  it('有失败原因或旧记录标记的失败记录仍显示失败', () => {
    const withReason = summary({
      boundary: 'failed',
      stage: 'failed',
      message: '提交结果待核对',
      failureReason: 'modelFailure'
    })
    expect(historyRowViewOf(withReason).status).toBe('失败')
    expect(historyDetailViewOf(withReason).stage).toBe('生成失败')
    expect(historyDetailViewOf(withReason).failureReason).toBe('模型暂时不可用')

    const legacy = summary({
      boundary: 'failed',
      stage: 'failed',
      message: '候选或基线冲突，需要重新核对',
      legacy: true
    })
    expect(historyRowViewOf(legacy).status).toBe('失败')
    expect(historyDetailViewOf(legacy).stage).toBe('生成失败')
    expect(historyDetailViewOf(legacy).legacy).toBe(true)
  })
})

describe('AI 历史行与详情渲染', () => {
  it('列表行不渲染阶段、耗时、候选或重试入口', () => {
    const html = renderList([summary({ boundary: 'failed', stage: 'failed' })])

    expect(html).toContain('wb-hist__row')
    expect(html).toContain('开始生成这一场。')
    expect(html).not.toContain('wb-hist__stage')
    expect(html).not.toContain('阶段')
    expect(html).not.toContain('耗时')
    expect(html).not.toContain('重试')
    expect(html).not.toContain('候选')
  })

  it('详情显示失败原因和旧记录，只保留返回按钮', () => {
    const html = renderDetail(
      summary({
        boundary: 'failed',
        stage: 'failed',
        message: '本次生成未完成',
        failureReason: 'modelFailure',
        legacy: true
      })
    )

    expect(html).toContain('记录时间')
    expect(html).toContain('操作边界')
    expect(html).toContain('所处阶段')
    expect(html).toContain('失败原因')
    expect(html).toContain('模型暂时不可用')
    expect(html).toContain(historyLegacyLabel)
    expect(html).toContain(historyLegacyNote)
    expect(html).toContain(historyReadonlyNote)
    expect(html).not.toContain('耗时')
    expect(html).not.toContain('重试')
    expect(html).not.toContain('恢复')
    expect(html).not.toContain('分叉')
    expect(html).not.toContain('wb-candidate')
    expect(html).not.toContain('wb-hist__more')
    expect((html.match(/<button/g) ?? []).length).toBe(1)
    expect(html).toContain('返回列表')
  })

  it('历史详情按记录自身显示旧 operation 终态，不读取实时状态', () => {
    const failed = renderDetail(
      summary({ boundary: 'failed', stage: 'failed', message: '本次生成未完成' })
    )
    expect(failed).toContain('生成失败')

    const committed = renderDetail(
      summary({ boundary: 'committed', stage: 'completed', message: '作品已提交' })
    )
    expect(committed).toContain('已提交')
    expect(committed).toContain('已完成')
  })

  it('旧记录缺失败原因时详情不渲染失败原因字段，也不补造原因', () => {
    const html = renderDetail(
      summary({ boundary: 'failed', stage: 'failed', message: '本次生成未完成', legacy: true })
    )

    expect(html).not.toContain('失败原因')
    expect(html).toContain(historyLegacyLabel)
    expect(html).toContain(historyLegacyNote)
  })

  it('待核对记录的列表和详情不渲染失败或生成失败', () => {
    const record = summary({ boundary: 'failed', stage: 'failed', message: '提交结果待核对' })
    const list = renderList([record])

    expect(list).toContain(historyPendingVerificationLabel)
    expect(list).toContain('提交结果待核对')
    expect(list).not.toContain('失败')

    const detail = renderDetail(record)
    expect(detail).toContain(historyPendingVerificationLabel)
    expect(detail).toContain(historyPendingVerificationStage)
    expect(detail).toContain('提交结果待核对')
    expect(detail).not.toContain('失败')
    expect(detail).not.toContain('失败原因')
    expect(detail).not.toContain(historyLegacyLabel)
  })

  it('普通记录详情不出现旧记录标记', () => {
    const html = renderDetail(
      summary({ boundary: 'committed', stage: 'completed', message: '作品已提交' })
    )

    expect(html).not.toContain(historyLegacyLabel)
    expect(html).not.toContain('失败原因')
  })
})

describe('AI 历史分页游标与更多判定', () => {
  it('游标取上一页最后一条 checkpointId', () => {
    expect(nextHistoryCursor([])).toBeNull()
    expect(
      nextHistoryCursor([
        summary({ checkpointId: 'checkpoint-1' }),
        summary({ checkpointId: 'checkpoint-2' })
      ])
    ).toBe('checkpoint-2')
  })

  it('只有满页才表示可能还有更早记录', () => {
    expect(historyHasMore(historyPageSize)).toBe(true)
    expect(historyHasMore(historyPageSize - 1)).toBe(false)
    expect(historyHasMore(0)).toBe(false)
    expect(historyHasMore(historyPageSize, 0)).toBe(false)
  })

  it('追加分页时保持顺序并按检查点去重', () => {
    const first = summary({ checkpointId: 'checkpoint-1', message: '首页记录' })
    const duplicate = summary({ checkpointId: 'checkpoint-1', message: '重复记录' })
    const next = summary({ checkpointId: 'checkpoint-2', message: '第二页记录' })

    expect(
      mergeHistoryPage([first], [duplicate, next], { projectId: 'project-1', sceneId: 'scene-1' })
    ).toEqual([first, next])
  })

  it('不混入其他工程或场景的记录', () => {
    const current = summary({ checkpointId: 'checkpoint-1' })
    const foreignProject = summary({ checkpointId: 'checkpoint-2', projectId: 'project-2' })
    const foreignScene = summary({ checkpointId: 'checkpoint-3', sceneId: 'scene-2' })
    const local = summary({ checkpointId: 'checkpoint-4' })

    expect(
      mergeHistoryPage([current], [foreignProject, foreignScene, local], {
        projectId: 'project-1',
        sceneId: 'scene-1'
      })
    ).toEqual([current, local])
  })
})

describe('AI 历史空、加载与错误判定', () => {
  it('没有记录时区分加载、错误和空态', () => {
    const expected: [Parameters<typeof historyViewStateOf>[0], HistoryViewState][] = [
      [{ count: 0, loading: true, error: null }, 'loading'],
      [{ count: 0, loading: false, error: '读取失败' }, 'error'],
      [{ count: 0, loading: false, error: null }, 'empty']
    ]

    for (const [input, state] of expected) {
      expect(historyViewStateOf(input)).toBe(state)
    }
  })

  it('已加载记录时读取失败保留列表', () => {
    expect(historyViewStateOf({ count: 3, loading: false, error: '读取失败' })).toBe('ready')
    expect(historyViewStateOf({ count: 3, loading: true, error: null })).toBe('ready')
  })
})

describe('AI 历史时间显示', () => {
  it('无效时间保留原文，不显示 Invalid Date', () => {
    expect(historyClock('not-a-date')).toBe('not-a-date')
    expect(historyFullTime('not-a-date')).toBe('not-a-date')
    expect(historySecondTime('not-a-date')).toBe('not-a-date')
  })

  it('有效时间使用本地紧凑格式', () => {
    const value = '2026-10-21T10:24:00.000Z'
    expect(historyClock(value)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(historyFullTime(value)).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
  })

  it('故障指纹的操作时间精确到秒且跟随本地时区', () => {
    const local = new Date(2026, 9, 21, 10, 24, 7)
    expect(historySecondTime(local.toISOString())).toBe('2026年10月21日 10:24:07')
    expect(historySecondTime('2026-10-21T10:24:00.000Z')).toMatch(
      /^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}$/
    )
  })
})
