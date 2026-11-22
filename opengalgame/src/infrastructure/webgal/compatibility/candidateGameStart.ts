import { WEBGAL_AUDITED_VERSION } from '@common/config/WebgalVersion'

import { WEBGAL_COMPATIBILITY_PROFILE } from './WebgalCompatibilityProfile'

/**
 * 固定 4.6.5 公开命令里没有“离开标题并开始候选入口”的命令。
 * `sync-scene` 只定位，`run-scene-content` 会替换运行内容，可见性命令只改界面标志。
 * 预览宿主只在显式启用受限引擎扩展时，于页面内一次性激活真实控件并加载 start.txt；
 * 应用侧只等待真实舞台快照，不发送坐标、不模拟点击、不注入剧情。
 */

export type CandidateStartFailure =
  '当前引擎不支持开始游戏' | '宿主无法开始游戏' | '游戏没有离开当前画面' | '游戏没有进入场景'

export class CandidateStartError extends Error {
  constructor(message: CandidateStartFailure) {
    super(message)
    this.name = 'CandidateStartError'
  }
}

export type CandidateStartSupport = 'host-autostart' | 'unsupported'

export type CandidateStageSnapshot = {
  readonly sceneName: string
  readonly sentenceId: number
  readonly stageState: unknown
}

export function selectCandidateStartSupport(input: {
  readonly packageVersion: string
  readonly commands: readonly string[]
}): CandidateStartSupport {
  if (input.packageVersion !== WEBGAL_AUDITED_VERSION) return 'unsupported'
  const actual = [...input.commands].sort()
  const expected = [...WEBGAL_COMPATIBILITY_PROFILE.previewCommands].sort()
  if (
    actual.length !== expected.length ||
    actual.some((command, index) => command !== expected[index])
  ) {
    return 'unsupported'
  }
  return 'host-autostart'
}

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
 * 预览宿主负责在页面内激活真实控件并加载 start.txt。
 * 这里只接受目标入口的真实游戏快照；标题、语言、注册和点击本身都不算开始。
 */
export async function confirmCandidateGame(options: {
  readonly sceneName: string
  readonly signal: AbortSignal
  readonly feed: CandidateStageFeed
  readonly support: CandidateStartSupport
}): Promise<void> {
  if (options.support !== 'host-autostart') {
    throw new CandidateStartError('当前引擎不支持开始游戏')
  }
  while (!options.signal.aborted) {
    const snapshot = await options.feed.next(options.signal)
    if (isCandidateGameState(snapshot, options.sceneName)) return
  }
  throw abortError(options.signal)
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
