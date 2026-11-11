import { afterEach, describe, expect, it, vi } from 'vitest'

import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import {
  CandidateStageFeed,
  confirmCandidateGame,
  isCandidateGameState,
  selectCandidateStartSupport,
  type CandidateScreenFacts,
  type CandidateStageSnapshot,
  type CandidateTrustedInput
} from '@infrastructure/webgal/compatibility/candidateGameStart'

const titleSnapshot: CandidateStageSnapshot = {
  sceneName: 'start.txt',
  sentenceId: 0,
  stageState: {
    showText: '',
    command: '',
    bgName: '',
    figName: '',
    choose: [],
    PerformList: [],
    currentDialogKey: 'initial'
  }
}

const gameSnapshot: CandidateStageSnapshot = {
  sceneName: 'start.txt',
  sentenceId: 1,
  stageState: {
    showText: '放学后的空地渐渐安静下来。',
    command: 'say',
    currentDialogKey: 'line-1'
  }
}

describe('候选游戏启动', () => {
  it('只把已审计的 4.6.5 公开命令集交给可信输入，不把定位命令当成启动', () => {
    expect(
      selectCandidateStartSupport({
        packageVersion: '4.6.5',
        commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
      })
    ).toBe('trusted-input')
    expect(
      selectCandidateStartSupport({
        packageVersion: '4.6.6',
        commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
      })
    ).toBe('unsupported')
    expect(
      selectCandidateStartSupport({
        packageVersion: '4.6.5',
        commands: [...WEBGAL_COMPATIBILITY_PROFILE.previewCommands, 'preview.command.start-game']
      })
    ).toBe('unsupported')
  })

  it('标题和注册快照不是游戏状态，目标入口出现台词后才是', () => {
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
        support: 'unsupported',
        input: null
      })
    ).rejects.toThrow('当前引擎不支持开始游戏')
  })

  it('没有可信输入时标题快照明确失败，不会就绪', async () => {
    const feed = new CandidateStageFeed()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: null
    })
    feed.push(titleSnapshot)
    await expect(pending).rejects.toThrow('宿主无法开始游戏')
  })

  it('点击后的空重置不能失败，随后的目标游戏快照才算开始', async () => {
    const feed = new CandidateStageFeed()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        async click() {
          feed.push(titleSnapshot)
          feed.push(gameSnapshot)
        }
      })
    })
    feed.push(titleSnapshot)
    await pending
  })

  it('点击后只有空重置时，超时才失败', async () => {
    const feed = new CandidateStageFeed()
    const controller = new AbortController()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: controller.signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        async click() {
          feed.push(titleSnapshot)
        }
      })
    })
    feed.push(titleSnapshot)
    controller.abort(new Error('等待 WebGAL 舞台状态超时'))
    await expect(pending).rejects.toThrow('超时')
  })

  it('点击后进入其他场景不能就绪', async () => {
    const feed = new CandidateStageFeed()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        async click() {
          feed.push({ ...gameSnapshot, sceneName: 'other.txt' })
          feed.push(gameSnapshot)
        }
      })
    })
    feed.push(titleSnapshot)
    await pending
  })

  it('语言选择优先简体中文，离开语言后才点开始，并等待游戏快照', async () => {
    const feed = new CandidateStageFeed()
    const clicks: number[] = []
    let phase: 'language' | 'title' = 'language'
    feed.push(titleSnapshot)
    await confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: {
        async readScreen() {
          if (phase === 'language') {
            return {
              languageButtons: [
                { text: 'English', x: 1, y: 1, disabled: false },
                { text: '简体中文', x: 8, y: 2, disabled: false }
              ],
              titleButtons: []
            }
          }
          return {
            languageButtons: [],
            titleButtons: [
              { text: '开始游戏', x: 4, y: 4, disabled: false },
              { text: '继续游戏', x: 5, y: 5, disabled: true }
            ]
          }
        },
        async click(target) {
          clicks.push(target.x)
          if (target.x === 8) phase = 'title'
          if (target.x === 4) feed.push(gameSnapshot)
        },
        async waitForLanguageDismissed() {
          if (phase !== 'title') throw new Error('游戏没有离开当前画面')
        }
      }
    })
    expect(clicks).toEqual([8, 4])
  })

  it('标题页有其他可用按钮时只点开始游戏，没有开始游戏则失败', async () => {
    const feed = new CandidateStageFeed()
    const clicks: string[] = []
    feed.push(titleSnapshot)
    await confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        async readScreen() {
          return {
            languageButtons: [],
            titleButtons: [
              { text: '继续游戏', x: 1, y: 1, disabled: false },
              { text: '开始游戏', x: 2, y: 2, disabled: false }
            ]
          }
        },
        async click(target) {
          clicks.push(String(target.x))
          feed.push(gameSnapshot)
        }
      })
    })
    expect(clicks).toEqual(['2'])

    const missing = new CandidateStageFeed()
    missing.push(titleSnapshot)
    await expect(
      confirmCandidateGame({
        sceneName: 'start',
        signal: new AbortController().signal,
        feed: missing,
        support: 'trusted-input',
        input: inputOf({
          async readScreen() {
            return {
              languageButtons: [],
              titleButtons: [{ text: '继续游戏', x: 1, y: 1, disabled: false }]
            }
          }
        })
      })
    ).rejects.toThrow('宿主无法开始游戏')
  })

  it('包装页先空屏后出现标题时继续等待并点击开始', async () => {
    const feed = new CandidateStageFeed()
    const clicks: number[] = []
    let reads = 0
    feed.push(titleSnapshot)
    await confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        stagePageUrl: 'http://127.0.0.1:9/stage',
        async readScreen() {
          reads += 1
          if (reads < 3) return { languageButtons: [], titleButtons: [] }
          return {
            languageButtons: [],
            titleButtons: [{ text: '开始游戏', x: 6, y: 6, disabled: false }]
          }
        },
        async click(point) {
          clicks.push(point.x)
          feed.push(gameSnapshot)
        }
      })
    })
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(clicks).toEqual([6])
  })

  it('Electron 读不到画面时继续等待，空读不能提前成功', async () => {
    vi.useFakeTimers()
    const feed = new CandidateStageFeed()
    const controller = new AbortController()
    let reads = 0
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: controller.signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        async readScreen() {
          reads += 1
          return null
        }
      })
    })
    feed.push(titleSnapshot)
    await vi.advanceTimersByTimeAsync(400)
    expect(reads).toBeGreaterThan(1)
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

  it('Electron 没有标题但已收到目标游戏快照时直接成功', async () => {
    const feed = new CandidateStageFeed()
    const clicks: number[] = []
    feed.push(titleSnapshot)
    feed.push(gameSnapshot)
    await confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        async readScreen() {
          return null
        },
        async click(point) {
          clicks.push(point.x)
        }
      })
    })
    expect(clicks).toEqual([])
  })

  it('没有标题但已经是目标游戏快照时直接成功', async () => {
    const feed = new CandidateStageFeed()
    const clicks: number[] = []
    feed.push(gameSnapshot)
    await confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        stagePageUrl: 'http://127.0.0.1:9/stage',
        async readScreen() {
          return { languageButtons: [], titleButtons: [] }
        },
        async click(point) {
          clicks.push(point.x)
        }
      })
    })
    expect(clicks).toEqual([])
  })

  it('始终空屏时等到超时才失败', async () => {
    const feed = new CandidateStageFeed()
    const controller = new AbortController()
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: controller.signal,
      feed,
      support: 'trusted-input',
      input: inputOf({
        stagePageUrl: 'http://127.0.0.1:9/stage',
        async readScreen() {
          return { languageButtons: [], titleButtons: [] }
        }
      })
    })
    feed.push(titleSnapshot)
    await Promise.resolve()
    controller.abort(new Error('等待 WebGAL 舞台状态超时'))
    await expect(pending).rejects.toThrow('超时')
  })

  it('语言画面没有变化时不再盲点开始', async () => {
    const feed = new CandidateStageFeed()
    const clicks: number[] = []
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: {
        async readScreen(): Promise<CandidateScreenFacts> {
          return {
            languageButtons: [{ text: '简体中文', x: 8, y: 2, disabled: false }],
            titleButtons: [{ text: '开始游戏', x: 4, y: 4, disabled: false }]
          }
        },
        async click(target) {
          clicks.push(target.x)
        },
        async waitForLanguageDismissed(): Promise<void> {
          return undefined
        }
      }
    })
    feed.push(titleSnapshot)
    await expect(pending).rejects.toThrow('游戏没有离开当前画面')
    expect(clicks).toEqual([8])
  })

  it('浏览器舞台输入只点击真实按钮，点击后继续等待游戏快照', async () => {
    const feed = new CandidateStageFeed()
    const clicks: string[] = []
    const pending = confirmCandidateGame({
      sceneName: 'start',
      signal: new AbortController().signal,
      feed,
      support: 'trusted-input',
      input: {
        async readScreen() {
          if (clicks.includes('简体中文')) {
            return {
              languageButtons: [],
              titleButtons: [{ text: '开始游戏', x: 0, y: 0, disabled: false }]
            }
          }
          return {
            languageButtons: [{ text: '简体中文', x: 0, y: 0, disabled: false }],
            titleButtons: []
          }
        },
        async click() {
          throw new Error('浏览器不能按坐标伪造点击')
        },
        async activate(button) {
          clicks.push(button.text)
        },
        async waitForLanguageDismissed() {
          return undefined
        }
      }
    })
    feed.push(titleSnapshot)
    const { promise: clicked, resolve: clickedNow } = Promise.withResolvers<void>()
    const timer = setInterval(() => {
      if (!clicks.includes('开始游戏')) return
      clearInterval(timer)
      clickedNow()
    }, 5)
    await clicked
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
    expect(clicks).toEqual(['简体中文', '开始游戏'])
    feed.push(gameSnapshot)
    await pending
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function inputOf(overrides: Partial<CandidateTrustedInput>): CandidateTrustedInput {
  return {
    async readScreen() {
      return {
        languageButtons: [],
        titleButtons: [{ text: '开始游戏', x: 3, y: 4, disabled: false }]
      }
    },
    async click(): Promise<void> {
      return undefined
    },
    async waitForLanguageDismissed(): Promise<void> {
      return undefined
    },
    ...overrides
  }
}
