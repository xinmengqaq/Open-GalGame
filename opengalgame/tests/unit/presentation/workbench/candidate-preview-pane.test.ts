import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { CandidatePreviewPane } from '@presentation/pages/workbench/drawer/candidate/CandidatePreviewPane'
import {
  gameStageEventOfCandidate,
  type GameStageEvent
} from '@presentation/features/game-stage/gameStageEvents'
import {
  candidatePreviewPhaseOf,
  candidatePreviewReducer,
  initialCandidatePreviewState,
  type CandidatePreviewState,
  type CandidatePreviewTarget
} from '@presentation/pages/workbench/drawer/candidate/candidatePreviewState'
import type { CandidatePreviewController } from '@presentation/pages/workbench/drawer/candidate/useCandidatePreview'

const target: CandidatePreviewTarget = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  operationId: 'operation-1',
  threadId: 'thread-1',
  branchId: 'branch-1',
  checkpointId: 'checkpoint-1',
  candidateSnapshotId: '0123456789abcdef'
}

function controllerOf(state: CandidatePreviewState): CandidatePreviewController {
  return {
    state,
    phase: candidatePreviewPhaseOf(state),
    reloadStage: vi.fn(),
    reopen: vi.fn(),
    retryRead: vi.fn()
  }
}

function opened(): CandidatePreviewState {
  return candidatePreviewReducer(
    candidatePreviewReducer(initialCandidatePreviewState, {
      type: 'start',
      projectId: target.projectId,
      sceneId: target.sceneId,
      candidateSnapshotId: target.candidateSnapshotId
    }),
    {
      type: 'opened',
      projectId: target.projectId,
      sceneId: target.sceneId,
      sessionId: 'session-secret-full-id',
      candidateSnapshotId: target.candidateSnapshotId,
      stageUrl: 'http://127.0.0.1:41000/?session=session-secret-full-id',
      expiresAt: Date.now() + 60_000
    }
  )
}

function stageEvent(
  event:
    | {
        type: 'ready' | 'stageFailed'
        sequence: number
        projectId: string
        sceneId: string
        previewSessionId: string
        candidateSnapshotId: string
        message?: string
      }
    | {
        type: 'invalidated'
        sequence: number
        projectId: string
        sceneId: string
        previewSessionId: string
        candidateSnapshotId: string
      }
): GameStageEvent {
  const mapped = gameStageEventOfCandidate(event, {
    projectId: target.projectId,
    sceneId: target.sceneId,
    previewSessionId: 'session-secret-full-id',
    candidateSnapshotId: target.candidateSnapshotId
  })
  if (mapped === null) throw new Error('测试事件没有通过候选身份核对')
  return mapped
}

describe('CandidatePreviewPane', () => {
  it('没有候选时不渲染任何节点', () => {
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, {
        controller: controllerOf(initialCandidatePreviewState)
      })
    )
    expect(html).toBe('')
  })

  it('就绪时只渲染真实舞台、场景名、只读和问题入口', () => {
    const ready = candidatePreviewReducer(
      candidatePreviewReducer(opened(), { type: 'read-started' }),
      {
        type: 'read-succeeded',
        preview: {
          projectId: target.projectId,
          sceneId: target.sceneId,
          sceneName: '雨夜重逢',
          readOnly: true,
          candidate: {
            previewSessionId: 'session-secret-full-id',
            candidateSnapshotId: target.candidateSnapshotId,
            expiresAt: '2026-10-26T12:15:00.000Z'
          },
          contentBasis: { digest: 'digest', parserVersion: 'parser', engineVersion: 'engine' },
          issues: [{ message: '缺少背景素材', assetName: 'sora_01.jpg' }]
        }
      }
    )
    const state = candidatePreviewReducer(ready, {
      type: 'event',
      event: stageEvent({
        type: 'ready',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId,
        message: '游戏已就绪'
      })
    })
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(state) })
    )

    expect(html).toContain('<iframe')
    expect(html).toContain('src="http://127.0.0.1:41000/?session=session-secret-full-id"')
    expect(html).toContain('allow="autoplay; fullscreen"')
    expect(html).toContain('游戏候选画面')
    expect(html).toContain('雨夜重逢')
    expect(html).toContain('只读')
    expect(html).toContain('01234567')
    expect(html).toContain('1 个读取问题')
    expect(html).toContain('缺少背景素材')
    expect(html).toContain('重新载入画面')
    expect(html).toContain('画面已就绪。没听到音乐时，先点“重新载入画面”，再点画面里的“开始游戏”。')
    expect(html).not.toContain('声音还没有确认')
    expect(html).not.toContain('接受')
    expect(html).not.toContain('保存候选')
    expect(html).not.toContain('接受并提交')
    expect(html).not.toContain('0123456789abcdef')
    expect(html).not.toContain('checkpoint-1')
  })

  it('打开中不提示声音，也不提供重新载入或重新打开', () => {
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(opened()) })
    )

    expect(html).toContain('<iframe')
    expect(html).toContain('正在启动游戏画面')
    expect(html).not.toContain('重新载入画面')
    expect(html).not.toContain('重新打开')
    expect(html).not.toContain('画面已就绪')
    expect(html).not.toContain('声音还没有确认')
  })

  it('打开超过冻结阈值后显示等待较久和重新打开动作，不伪造失败', () => {
    const stalled = candidatePreviewReducer(opened(), { type: 'opening-stalled' })
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(stalled) })
    )

    expect(html).toContain('仍在启动游戏画面')
    expect(html).toContain('仍在打开游戏候选')
    expect(html).toContain('等待较久')
    expect(html).toContain('重新打开')
    expect(html).toContain('data-stalled="true"')
    expect(html).toContain('<iframe')
    expect(html).not.toContain('游戏加载失败')
    expect(html).not.toContain('游戏候选暂时打不开')
    expect(html).not.toContain('重新载入画面')
  })

  it('舞台失败卸载 iframe 并保留安全原因和重新运行入口', () => {
    const failed = candidatePreviewReducer(opened(), {
      type: 'event',
      event: stageEvent({
        type: 'stageFailed',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId,
        message: '游戏加载超时'
      })
    })
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(failed) })
    )

    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('画面已就绪')
    expect(html).not.toContain('声音还没有确认')
    expect(html).toContain('游戏加载超时')
    expect(html).toContain('重新运行')
    expect(html).not.toContain('接受')
    expect(html).not.toContain('保存候选')
    expect(html).not.toContain('接受并提交')
  })

  it('失效后卸载舞台并给出重新打开动作', () => {
    const invalidated = candidatePreviewReducer(opened(), {
      type: 'event',
      event: stageEvent({
        type: 'invalidated',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId
      })
    })
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(invalidated) })
    )

    expect(html).not.toContain('<iframe')
    expect(html).toContain('此游戏候选已失效')
    expect(html).toContain('重新打开候选')
    expect(html).not.toContain('session-secret-full-id')
  })

  it('运行会话到期后卸载画面，但保留候选身份、问题和重新运行入口', () => {
    const ready = candidatePreviewReducer(
      candidatePreviewReducer(opened(), { type: 'read-started' }),
      {
        type: 'read-succeeded',
        preview: {
          projectId: target.projectId,
          sceneId: target.sceneId,
          sceneName: '雨夜重逢',
          readOnly: true,
          candidate: {
            previewSessionId: 'session-secret-full-id',
            candidateSnapshotId: target.candidateSnapshotId,
            expiresAt: '2026-10-26T12:15:00.000Z'
          },
          contentBasis: { digest: 'digest', parserVersion: 'parser', engineVersion: 'engine' },
          issues: [{ message: '缺少背景素材', assetName: 'sora_01.jpg' }]
        }
      }
    )
    const expired = candidatePreviewReducer(ready, { type: 'expire' })
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(expired) })
    )

    expect(html).not.toContain('<iframe')
    expect(html).toContain('游戏运行已过期')
    expect(html).toContain('雨夜重逢')
    expect(html).toContain('01234567')
    expect(html).toContain('1 个读取问题')
    expect(html).toContain('重新运行')
    expect(html).not.toContain('session-secret-full-id')
  })

  it('舞台失败展示安全原因，没有原因或未映射文本时保留固定说明', () => {
    const withReason = candidatePreviewReducer(opened(), {
      type: 'event',
      event: stageEvent({
        type: 'stageFailed',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId,
        message: '游戏没有离开当前画面'
      })
    })
    const reasonHtml = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(withReason) })
    )
    expect(reasonHtml).toContain('游戏没有离开当前画面')
    expect(reasonHtml).toContain('游戏加载失败')
    expect(reasonHtml).not.toContain('引擎没有加载这个游戏候选')

    const withoutReason = candidatePreviewReducer(opened(), {
      type: 'event',
      event: stageEvent({
        type: 'stageFailed',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId
      })
    })
    const fallbackHtml = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(withoutReason) })
    )
    expect(fallbackHtml).toContain('引擎没有加载这个游戏候选')

    const unsafe = candidatePreviewReducer(opened(), {
      type: 'event',
      event: stageEvent({
        type: 'stageFailed',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId,
        message: 'ENOENT D:/secret/start.txt Error stack'
      })
    })
    const unsafeHtml = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(unsafe) })
    )
    expect(unsafeHtml).toContain('引擎没有加载这个游戏候选')
    expect(unsafeHtml).not.toContain('ENOENT')
    expect(unsafeHtml).not.toContain('D:/secret/start.txt')
  })

  it('打开失败继续使用 failureMessage，不显示上一会话的舞台失败原因', () => {
    const stageFailed = candidatePreviewReducer(opened(), {
      type: 'event',
      event: stageEvent({
        type: 'stageFailed',
        sequence: 1,
        projectId: target.projectId,
        sceneId: target.sceneId,
        previewSessionId: 'session-secret-full-id',
        candidateSnapshotId: target.candidateSnapshotId,
        message: '游戏加载超时'
      })
    })
    const reopening = candidatePreviewReducer(stageFailed, {
      type: 'start',
      projectId: target.projectId,
      sceneId: target.sceneId,
      candidateSnapshotId: target.candidateSnapshotId
    })
    const openFailed = candidatePreviewReducer(reopening, {
      type: 'open-failed',
      message: '候选修订未发布',
      unsupported: false
    })
    const html = renderToStaticMarkup(
      createElement(CandidatePreviewPane, { controller: controllerOf(openFailed) })
    )

    expect(html).toContain('候选修订未发布')
    expect(html).not.toContain('游戏加载超时')
    expect(html).not.toContain('引擎没有加载这个游戏候选')
  })
})
