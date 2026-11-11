import { readFileSync } from 'node:fs'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  CandidatePreviewContext,
  type CandidatePreviewTabController
} from '@presentation/pages/workbench/drawer/candidate/candidatePreviewContext'
import { CandidatePreviewTab } from '@presentation/pages/workbench/drawer/candidate/CandidatePreviewTab'
import {
  candidateEntryHintOf,
  candidatePreviewPhaseOf,
  candidatePreviewReducer,
  candidateTabBadgeOf,
  initialCandidatePreviewState,
  type CandidatePreviewState
} from '@presentation/pages/workbench/drawer/candidate/candidatePreviewState'

function stageStarted(candidateSnapshotId = '0123456789abcdef'): CandidatePreviewState {
  return candidatePreviewReducer(initialCandidatePreviewState, {
    type: 'start',
    projectId: 'project-1',
    sceneId: 'scene-1',
    candidateSnapshotId
  })
}

function tabController(): CandidatePreviewTabController {
  const opened = candidatePreviewReducer(stageStarted(), {
    type: 'opened',
    projectId: 'project-1',
    sceneId: 'scene-1',
    sessionId: 'session-1',
    candidateSnapshotId: '0123456789abcdef',
    stageUrl: 'http://127.0.0.1:41000/',
    expiresAt: Date.now() + 60_000
  })
  const state = candidatePreviewReducer(candidatePreviewReducer(opened, { type: 'read-started' }), {
    type: 'read-succeeded',
    preview: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      sceneName: '雨夜重逢',
      readOnly: true,
      candidate: {
        previewSessionId: 'session-1',
        candidateSnapshotId: '0123456789abcdef',
        expiresAt: '2026-10-27T12:15:00.000Z'
      },
      contentBasis: { digest: 'digest', parserVersion: 'parser', engineVersion: 'engine' },
      issues: [{ message: '缺少背景素材', assetName: 'sora_01.jpg' }]
    }
  })
  return {
    state,
    phase: candidatePreviewPhaseOf(state),
    reloadStage: vi.fn(),
    reopen: vi.fn(),
    retryRead: vi.fn(),
    available: true,
    activate: vi.fn()
  }
}

describe('candidateTabBadgeOf', () => {
  it('打开中只显示活动点，不把旧问题数带进标签', () => {
    const opening = stageStarted()
    expect(candidateTabBadgeOf(opening)).toEqual({ count: 0, live: true })
  })

  it('读取成功后按真实问题数显示角标，没有问题时显示活动点', () => {
    const opened = candidatePreviewReducer(stageStarted(), {
      type: 'opened',
      projectId: 'project-1',
      sceneId: 'scene-1',
      sessionId: 'session-1',
      candidateSnapshotId: '0123456789abcdef',
      stageUrl: 'http://127.0.0.1:41000/',
      expiresAt: Date.now() + 60_000
    })
    const ready = candidatePreviewReducer(
      candidatePreviewReducer(opened, { type: 'read-started' }),
      {
        type: 'read-succeeded',
        preview: {
          projectId: 'project-1',
          sceneId: 'scene-1',
          sceneName: '雨夜重逢',
          readOnly: true,
          candidate: {
            previewSessionId: 'session-1',
            candidateSnapshotId: '0123456789abcdef',
            expiresAt: '2026-10-27T12:15:00.000Z'
          },
          contentBasis: { digest: 'digest', parserVersion: 'parser', engineVersion: 'engine' },
          issues: [
            { message: '缺少背景素材', assetName: 'sora_01.jpg' },
            { message: '有一条语句当前不能识别' }
          ]
        }
      }
    )

    expect(candidateTabBadgeOf(ready)).toEqual({ count: 2, live: false })
    expect(candidateTabBadgeOf({ ...ready, issues: [] })).toEqual({ count: 0, live: true })
  })

  it('读取失败不保留问题角标', () => {
    const opened = candidatePreviewReducer(stageStarted(), {
      type: 'opened',
      projectId: 'project-1',
      sceneId: 'scene-1',
      sessionId: 'session-1',
      candidateSnapshotId: '0123456789abcdef',
      stageUrl: 'http://127.0.0.1:41000/',
      expiresAt: Date.now() + 60_000
    })
    const failed = candidatePreviewReducer(opened, {
      type: 'read-failed',
      message: '读取失败',
      sessionRejected: false
    })
    expect(candidateTabBadgeOf(failed)).toEqual({ count: 0, live: false })
  })
})

describe('candidateEntryHintOf', () => {
  it('按会话阶段提示下一步，不把过期说成候选失效', () => {
    expect(candidateEntryHintOf('opening')).toBe('正在打开只读游戏画面')
    expect(candidateEntryHintOf('ready')).toBe('查看真实游戏画面与读取问题')
    expect(candidateEntryHintOf('stage-failed')).toBe('游戏加载失败，打开后可以重新运行')
    expect(candidateEntryHintOf('read-failed')).toBe('打开后可以重新读取')
    expect(candidateEntryHintOf('expired')).toBe('运行会话已过期，打开后可以重新运行')
    expect(candidateEntryHintOf('invalidated')).toBe('候选已更新，打开后可以查看新的候选')
    expect(candidateEntryHintOf('unsupported')).toBe('当前环境不支持游戏预览')
    expect(candidateEntryHintOf(null)).toBe('打开只读游戏候选')
  })

  it('打开超过冻结阈值时提示仍在启动，可以打开后重新打开', () => {
    expect(candidateEntryHintOf('opening', true)).toBe('仍在启动游戏画面，打开后可以重新打开')
  })
})

describe('CandidatePreviewTab', () => {
  it('没有抽屉级候选会话时不创建第二份舞台', () => {
    expect(renderToStaticMarkup(createElement(CandidatePreviewTab))).toBe('')
  })

  it('有候选会话时只呈现只读画面、场景和问题，不提供接受或修改操作', () => {
    const html = renderToStaticMarkup(
      createElement(
        CandidatePreviewContext.Provider,
        { value: tabController() },
        createElement(CandidatePreviewTab)
      )
    )

    expect(html).toContain('wb-candidate-tab')
    expect(html).toContain('游戏候选')
    expect(html).toContain('雨夜重逢')
    expect(html).toContain('只读')
    expect(html).toContain('1 个读取问题')
    expect(html).not.toContain('接受')
    expect(html).not.toContain('保存候选')
    expect(html).not.toContain('接受并提交')
    expect(html).not.toContain('修改候选')
  })
})

describe('GameStageFrame loading overlay', () => {
  it('加载提示覆盖层不拦截舞台指针，只有操作按钮可点击', () => {
    const css = readFileSync(
      new URL(
        '../../../../src/presentation/features/game-stage/GameStageFrame.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const loading = css.match(/\.loading\s*\{([^}]*)\}/)?.[1] ?? ''
    const action = css.match(/\.loadingAction\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(loading).toContain('pointer-events: none')
    expect(action).toContain('pointer-events: auto')
  })
})
