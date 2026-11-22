import { describe, expect, it } from 'vitest'

import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import {
  CandidateStageFeed,
  confirmCandidateGame,
  isCandidateGameState,
  selectCandidateStartSupport,
  type CandidateStageSnapshot
} from '@infrastructure/webgal/compatibility/candidateGameStart'

const titleSnapshot: CandidateStageSnapshot = {
  sceneName: 'start.txt',
  sentenceId: 0,
  stageState: { showText: '', command: '', bgName: '', currentDialogKey: 'initial' }
}

const gameSnapshot: CandidateStageSnapshot = {
  sceneName: 'start.txt',
  sentenceId: 1,
  stageState: { bgName: './game/background/doorway_black.png', currentDialogKey: 'initial' }
}

describe('候选游戏启动', () => {
  it('只把已审计的 4.6.5 公开命令集交给宿主内自动开始', () => {
    expect(
      selectCandidateStartSupport({
        packageVersion: '4.6.5',
        commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
      })
    ).toBe('host-autostart')
    expect(
      selectCandidateStartSupport({
        packageVersion: '4.6.6',
        commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
      })
    ).toBe('unsupported')
    expect(
      selectCandidateStartSupport({
        packageVersion: '4.6.5',
        commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands.slice(1)
      })
    ).toBe('unsupported')
  })

  it('标题和注册快照不是游戏状态，目标入口出现真实舞台事实后才是', () => {
    expect(isCandidateGameState(titleSnapshot, 'start')).toBe(false)
    expect(isCandidateGameState({ ...titleSnapshot, sceneName: 'title' }, 'start')).toBe(false)
    expect(isCandidateGameState(gameSnapshot, 'start')).toBe(true)
    expect(isCandidateGameState({ ...gameSnapshot, sceneName: 'other.txt' }, 'start')).toBe(false)
    expect(
      isCandidateGameState(
        {
          ...titleSnapshot,
          stageState: { ...(titleSnapshot.stageState as object), showText: '一句' }
        },
        'start'
      )
    ).toBe(true)
  })

  it('版本不支持时即使快照像游戏也失败，不降级为就绪', async () => {
    const feed = new CandidateStageFeed()
    feed.push(gameSnapshot)
    await expect(
      confirmCandidateGame({
        sceneName: 'start',
        signal: new AbortController().signal,
        feed,
        support: 'unsupported'
      })
    ).rejects.toThrow('当前引擎不支持开始游戏')
  })

  it('只有标题快照时持续等待，不把点击或注册当成开始', async () => {
    const feed = new CandidateStageFeed()
    const controller = new AbortController()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: controller.signal,
      feed,
      support: 'host-autostart'
    })
    feed.push(titleSnapshot)
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    controller.abort(new Error('等待 WebGAL 舞台状态超时'))
    await expect(pending).rejects.toThrow('超时')
  })

  it('标题快照之后的真实游戏快照才返回', async () => {
    const feed = new CandidateStageFeed()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'host-autostart'
    })
    feed.push(titleSnapshot)
    await Promise.resolve()
    feed.push(gameSnapshot)
    await expect(pending).resolves.toBeUndefined()
  })

  it('进入其他场景不能就绪，目标入口快照才返回', async () => {
    const feed = new CandidateStageFeed()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'host-autostart'
    })
    feed.push({ ...gameSnapshot, sceneName: 'other.txt' })
    await Promise.resolve()
    feed.push(gameSnapshot)
    await expect(pending).resolves.toBeUndefined()
  })

  it('已经是目标游戏快照时直接成功', async () => {
    const feed = new CandidateStageFeed()
    feed.push(gameSnapshot)
    await expect(
      confirmCandidateGame({
        sceneName: 'start',
        signal: new AbortController().signal,
        feed,
        support: 'host-autostart'
      })
    ).resolves.toBeUndefined()
  })

  it('始终只有空重置时等到中止才失败', async () => {
    const feed = new CandidateStageFeed()
    const controller = new AbortController()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: controller.signal,
      feed,
      support: 'host-autostart'
    })
    feed.push(titleSnapshot)
    await Promise.resolve()
    controller.abort(new Error('等待 WebGAL 舞台状态超时'))
    await expect(pending).rejects.toThrow('超时')
  })
})
