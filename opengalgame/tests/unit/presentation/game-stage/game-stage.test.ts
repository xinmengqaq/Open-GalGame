import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { PreviewRuntimeEventVO } from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { CandidatePreviewEventVO } from '@interfaces/scene-preview/contracts/ScenePreviewResponseSchema'
import {
  GameStageFrame,
  GAME_STAGE_IFRAME_ALLOW
} from '@presentation/features/game-stage/GameStageFrame'
import { GameStageLoading } from '@presentation/features/game-stage/GameStageLoading'
import { GameStageStatePanel } from '@presentation/features/game-stage/GameStageStatePanel'
import {
  gameStageEventOfCandidate,
  gameStageEventOfRuntime
} from '@presentation/features/game-stage/gameStageEvents'

const runtimeStage: PreviewRuntimeEventVO = {
  type: 'stage',
  previewSessionId: 'session-1',
  contentBasis: { digest: 'digest', parserVersion: 'parser', engineVersion: 'engine' },
  runtimeGeneration: 3,
  sequence: 7,
  phase: 'paused',
  position: { kind: 'dialogue', dialogueId: 'line-2' }
}

const candidateIdentity = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  previewSessionId: 'session-1',
  candidateSnapshotId: '0123456789abcdef'
}

function candidateEvent(
  type: CandidatePreviewEventVO['type'],
  sequence = 1
): CandidatePreviewEventVO {
  const identity = {
    sequence,
    ...candidateIdentity
  }
  if (type === 'invalidated') return { type, ...identity }
  return { type, ...identity, message: type === 'ready' ? '游戏已就绪' : '游戏没有启动' }
}

describe('gameStageEvents', () => {
  it('当前场景的舞台快照转成带代次和句位的就绪事件', () => {
    expect(gameStageEventOfRuntime(runtimeStage, 'session-1')).toEqual({
      type: 'ready',
      sequence: 7,
      identity: {
        previewSessionId: 'session-1',
        projectId: null,
        sceneId: null,
        candidateSnapshotId: null
      },
      runtime: {
        runtimeGeneration: 3,
        phase: 'paused',
        position: { kind: 'dialogue', dialogueId: 'line-2' }
      },
      failure: null,
      lastConfirmed: null,
      message: null
    })
    expect(gameStageEventOfRuntime(runtimeStage, 'session-2')).toBeNull()
  })

  it('当前场景的失败事件保留错误码、恢复动作和最后确认状态', () => {
    const event = gameStageEventOfRuntime(
      {
        type: 'failed',
        previewSessionId: 'session-1',
        contentBasis: { digest: 'digest', parserVersion: 'parser', engineVersion: 'engine' },
        runtimeGeneration: 3,
        sequence: 8,
        failure: {
          code: 'runtimeDisconnected',
          message: 'runtimeDisconnected',
          recovery: 'reopen'
        },
        lastConfirmed: { kind: 'known', phase: 'paused', position: { kind: 'unknown' } }
      },
      'session-1'
    )

    expect(event?.type).toBe('failed')
    expect(event?.failure).toEqual({
      code: 'runtimeDisconnected',
      message: 'runtimeDisconnected',
      recovery: 'reopen'
    })
    expect(event?.lastConfirmed).toEqual({
      kind: 'known',
      phase: 'paused',
      position: { kind: 'unknown' }
    })
  })

  it('候选的就绪、失败和失效走同一份事件形状，身份不符时丢弃', () => {
    expect(gameStageEventOfCandidate(candidateEvent('ready'), candidateIdentity)?.type).toBe(
      'ready'
    )
    expect(gameStageEventOfCandidate(candidateEvent('stageFailed'), candidateIdentity)?.type).toBe(
      'failed'
    )
    expect(gameStageEventOfCandidate(candidateEvent('invalidated'), candidateIdentity)?.type).toBe(
      'invalidated'
    )
    expect(
      gameStageEventOfCandidate(candidateEvent('ready'), {
        ...candidateIdentity,
        candidateSnapshotId: 'another-candidate'
      })
    ).toBeNull()
  })
})

describe('GameStageFrame', () => {
  it('没有确认的舞台地址时不创建 iframe', () => {
    const html = renderToStaticMarkup(
      createElement(GameStageFrame, {
        src: null,
        title: '游戏舞台',
        status: 'loading'
      })
    )

    expect(html).not.toContain('<iframe')
    expect(html).toContain('data-stage-status="loading"')
  })

  it('有确认地址时只渲染一个真实 iframe，并保留调用方的标题', () => {
    const html = renderToStaticMarkup(
      createElement(GameStageFrame, {
        src: 'http://127.0.0.1:41000/index.html',
        title: '游戏候选画面',
        status: 'ready'
      })
    )

    expect(html).toContain('<iframe')
    expect(html).toContain('title="游戏候选画面"')
    expect(html).toContain('src="http://127.0.0.1:41000/index.html"')
    expect(html).toContain(`allow="${GAME_STAGE_IFRAME_ALLOW}"`)
    expect(GAME_STAGE_IFRAME_ALLOW).toContain('autoplay')
    expect(html.match(/<iframe/g)).toHaveLength(1)
  })
})

describe('GameStageLoading 与 GameStageStatePanel', () => {
  it('加载提示不生成演示画面，只说明等待状态', () => {
    const html = renderToStaticMarkup(
      createElement(GameStageLoading, {
        title: '正在准备舞台',
        description: '准备好后，真实画面会出现在这里。'
      })
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('正在准备舞台')
    expect(html).toContain('准备好后，真实画面会出现在这里。')
  })

  it('错误和过期共用状态面板结构，主动作和说明由调用方提供', () => {
    const html = renderToStaticMarkup(
      createElement(GameStageStatePanel, {
        surface: 'paper',
        accent: 'warning',
        title: '游戏候选已过期',
        description: '旧画面和问题已清空。',
        icon: createElement('span', null, 'icon'),
        actions: createElement('button', { type: 'button' }, '重新打开候选'),
        note: '可以继续查看新的候选。',
        role: 'status'
      })
    )

    expect(html).toContain('data-surface="paper"')
    expect(html).toContain('data-accent="warning"')
    expect(html).toContain('role="status"')
    expect(html).toContain('游戏候选已过期')
    expect(html).toContain('旧画面和问题已清空。')
    expect(html).toContain('重新打开候选')
    expect(html).toContain('可以继续查看新的候选。')
  })
})
