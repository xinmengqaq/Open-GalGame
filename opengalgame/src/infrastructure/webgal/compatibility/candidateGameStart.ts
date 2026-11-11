import { WEBGAL_COMPATIBILITY_PROFILE } from './WebgalCompatibilityProfile'

/**
 * 固定 4.6.5 公开命令里没有“离开标题并开始候选入口”的命令。
 * `sync-scene` 只定位，`run-scene-content` 会替换运行内容，可见性命令只改界面标志。
 */
const AUDITED_ENGINE_VERSION = '4.6.5'

export type CandidateStartFailure =
  '当前引擎不支持开始游戏' | '宿主无法开始游戏' | '游戏没有离开当前画面' | '游戏没有进入场景'

export class CandidateStartError extends Error {
  constructor(message: CandidateStartFailure) {
    super(message)
    this.name = 'CandidateStartError'
  }
}

export type CandidateStartSupport = 'trusted-input' | 'unsupported'

export type CandidateStageSnapshot = {
  readonly sceneName: string
  readonly sentenceId: number
  readonly stageState: unknown
}

export type CandidateScreenButton = {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly disabled: boolean
}

export type CandidateScreenFacts = {
  readonly languageButtons: readonly CandidateScreenButton[]
  readonly titleButtons: readonly CandidateScreenButton[]
}

/**
 * 宿主到引擎的真实输入。点击只表示输入已送达，不表示游戏已经开始。
 */
export interface CandidateTrustedInput {
  /** 浏览器舞台页地址。Electron 输入不提供，页面继续直接嵌入引擎。 */
  readonly stagePageUrl?: string
  readScreen(signal: AbortSignal): Promise<CandidateScreenFacts | null>
  click(target: { readonly x: number; readonly y: number }): Promise<void>
  /**
   * 浏览器舞台只能点到真实按钮元素。坐标点击不能代替它。
   * 没有实现时，语言和开始仍走 click。
   */
  activate?(button: CandidateScreenButton): Promise<void>
  waitForLanguageDismissed(signal: AbortSignal): Promise<void>
}

export type CandidateTrustedInputSource = (target: {
  readonly stageUrl: string
  readonly signal: AbortSignal
}) => CandidateTrustedInput | null

export function selectCandidateStartSupport(input: {
  readonly packageVersion: string
  readonly commands: readonly string[]
}): CandidateStartSupport {
  if (input.packageVersion !== AUDITED_ENGINE_VERSION) return 'unsupported'
  const actual = [...input.commands].sort()
  const expected = [...WEBGAL_COMPATIBILITY_PROFILE.previewCommands].sort()
  if (
    actual.length !== expected.length ||
    actual.some((command, index) => command !== expected[index])
  ) {
    return 'unsupported'
  }
  return 'trusted-input'
}

/**
 * 注册快照和标题页会带上入口场景名，但舞台仍是初始空态。
 * 只有脚本已经留下可见事实，才算目标入口进入了真实游戏。
 */
export function isCandidateGameState(snapshot: CandidateStageSnapshot, sceneName: string): boolean {
  if (sceneLabel(snapshot.sceneName) !== sceneName) return false
  if (!snapshot.stageState || typeof snapshot.stageState !== 'object') return false
  const stage = snapshot.stageState as Record<string, unknown>
  if (snapshot.sentenceId > 0) return true
  if (nonEmpty(stage.showText) || nonEmpty(stage.command) || nonEmpty(stage.bgName)) return true
  if (nonEmpty(stage.figName) || nonEmpty(stage.figNameLeft) || nonEmpty(stage.figNameRight))
    return true
  if (Array.isArray(stage.choose) && stage.choose.length > 0) return true
  if (Array.isArray(stage.PerformList) && stage.PerformList.length > 0) return true
  return typeof stage.currentDialogKey === 'string' && stage.currentDialogKey !== 'initial'
}

export class CandidateStageFeed {
  private readonly pending: CandidateStageSnapshot[] = []
  private readonly waiters = new Set<
    (result: { ok: true; snapshot: CandidateStageSnapshot } | { ok: false; error: Error }) => void
  >()
  private error: Error | undefined

  push(snapshot: CandidateStageSnapshot): void {
    if (this.error) return
    const waiter = this.waiters.values().next().value
    if (waiter) {
      this.waiters.delete(waiter)
      waiter({ ok: true, snapshot })
      return
    }
    this.pending.push(snapshot)
  }

  fail(error: Error): void {
    if (this.error) return
    this.error = error
    for (const waiter of this.waiters) waiter({ ok: false, error })
    this.waiters.clear()
  }

  drain(): CandidateStageSnapshot[] {
    return this.pending.splice(0)
  }

  next(signal: AbortSignal): Promise<CandidateStageSnapshot> {
    const queued = this.pending.shift()
    if (queued) return Promise.resolve(queued)
    if (this.error) return Promise.reject(this.error)
    if (signal.aborted) return Promise.reject(abortError(signal))
    const { promise, resolve, reject } = Promise.withResolvers<CandidateStageSnapshot>()
    const finish = (
      result: { ok: true; snapshot: CandidateStageSnapshot } | { ok: false; error: Error }
    ): void => {
      signal.removeEventListener('abort', onAbort)
      if (result.ok) resolve(result.snapshot)
      else reject(result.error)
    }
    const onAbort = (): void => {
      this.waiters.delete(finish)
      reject(abortError(signal))
    }
    this.waiters.add(finish)
    signal.addEventListener('abort', onAbort, { once: true })
    return promise
  }
}

/**
 * 先确认公开协议不能启动，再按画面发送一次可信输入并等待真实状态变化。
 * 点击本身、注册快照和标题快照都不会返回。
 */
export async function confirmCandidateGame(options: {
  readonly sceneName: string
  readonly signal: AbortSignal
  readonly feed: CandidateStageFeed
  readonly support: CandidateStartSupport
  readonly input: CandidateTrustedInput | null
}): Promise<void> {
  if (options.support !== 'trusted-input') {
    throw new CandidateStartError('当前引擎不支持开始游戏')
  }
  const first = await options.feed.next(options.signal)
  if (!options.input) throw new CandidateStartError('宿主无法开始游戏')
  if (options.signal.aborted) throw abortError(options.signal)
  if (isCandidateGameState(first, options.sceneName)) return
  options.feed.push(first)

  const title = await readTitleScreen(
    options.input,
    options.signal,
    options.feed,
    options.sceneName
  )
  if (options.signal.aborted) throw abortError(options.signal)
  if (title.status === 'started') return
  let screen = title.screen

  const language = preferredLanguageButton(screen.languageButtons)
  if (language) {
    await clickButton(options.input, language)
    await options.input.waitForLanguageDismissed(options.signal)
    const next = await readTitleScreen(
      options.input,
      options.signal,
      options.feed,
      options.sceneName
    )
    if (options.signal.aborted) throw abortError(options.signal)
    if (next.status === 'started') return
    screen = next.screen
    if (screen.languageButtons.length > 0) {
      throw new CandidateStartError('游戏没有离开当前画面')
    }
  }
  options.feed.drain()
  const start = screen.titleButtons.find(
    (button) => !button.disabled && button.text.includes('开始游戏')
  )
  if (!start) throw new CandidateStartError('宿主无法开始游戏')
  await clickButton(options.input, start)
  while (!options.signal.aborted) {
    const snapshot = await options.feed.next(options.signal)
    if (isCandidateGameState(snapshot, options.sceneName)) return
  }
  throw abortError(options.signal)
}

/**
 * 包装页可能先给出空屏。没有标题按钮时等到 signal 超时；
 * 期间若已收到目标游戏快照则直接成功。已有标题按钮但没有「开始游戏」才立即失败。
 * 读不到画面只表示继续等待，不能和已收到真实游戏快照混成同一种成功。
 */
type TitleRead =
  | { readonly status: 'started' }
  | { readonly status: 'title'; readonly screen: CandidateScreenFacts }

async function readTitleScreen(
  input: CandidateTrustedInput,
  signal: AbortSignal,
  feed: CandidateStageFeed,
  sceneName: string
): Promise<TitleRead> {
  let screen = await input.readScreen(signal)
  while (!signal.aborted) {
    const started = takeStarted(feed, sceneName)
    if (started) return { status: 'started' }
    if (screen && (screen.titleButtons.length > 0 || screen.languageButtons.length > 0)) {
      return { status: 'title', screen }
    }
    await delay(150, signal)
    screen = await input.readScreen(signal)
  }
  if (takeStarted(feed, sceneName)) return { status: 'started' }
  throw abortError(signal)
}

function takeStarted(feed: CandidateStageFeed, sceneName: string): boolean {
  const queued = feed.drain()
  const started = queued.some((snapshot) => isCandidateGameState(snapshot, sceneName))
  for (const snapshot of queued) feed.push(snapshot)
  return started
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = (): void => {
    clearTimeout(timer)
    reject(abortError(signal))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return promise
}

async function clickButton(
  input: CandidateTrustedInput,
  button: CandidateScreenButton
): Promise<void> {
  if (input.activate) {
    await input.activate(button)
    return
  }
  if (!Number.isFinite(button.x) || !Number.isFinite(button.y)) {
    throw new CandidateStartError('宿主无法开始游戏')
  }
  await input.click({ x: button.x, y: button.y })
}

function preferredLanguageButton(
  buttons: readonly CandidateScreenButton[]
): CandidateScreenButton | undefined {
  const enabled = buttons.filter((button) => !button.disabled)
  return enabled.find((button) => button.text.includes('简体中文')) ?? enabled[0]
}

function sceneLabel(sceneName: string): string {
  const normalized = sceneName.replaceAll('\\', '/').replace(/\.txt$/u, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error('等待 WebGAL 舞台状态超时')
}
