import type { PreviewErrorVO } from '@application/scene-preview/vo/PreviewErrorVO'
import type {
  WebgalPreviewConnection,
  WebgalRuntimeHandle
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import {
  CandidateStageFeed,
  CandidateStartError,
  confirmCandidateGame,
  selectCandidateStartSupport
} from '@infrastructure/webgal/compatibility/candidateGameStart'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

import { runtimeFailure } from '../previewRuntimeErrors'
import {
  sceneIdentity,
  type ReadyWaiter,
  type RuntimeSession,
  type StageSnapshot
} from './PreviewRuntimeSessionRegistry'

export type PreviewRuntimeStartupOptions = {
  readonly timeoutMs: number
  readonly startupTimeoutMs: number
}

export type PreviewRuntimeReadyWaiters = {
  readyConnection(): WebgalPreviewConnection | undefined
  addReadyWaiter(waiter: ReadyWaiter): void
  removeReadyWaiter(waiter: ReadyWaiter): void
}

export class PreviewRuntimeStartup {
  private readonly timeoutMs: number
  private readonly startupTimeoutMs: number

  constructor(options: PreviewRuntimeStartupOptions) {
    this.timeoutMs = options.timeoutMs
    this.startupTimeoutMs = options.startupTimeoutMs
  }

  /** 每次准备都换一份运行代次，旧页面或旧等待不能进入新舞台。 */
  reset(session: RuntimeSession, handle: WebgalRuntimeHandle): void {
    session.startupAttemptAbort?.abort(new Error('预览会话已关闭'))
    session.startupAttemptAbort = undefined
    session.startup = undefined
    session.startupConnection = undefined
    session.startFeed = undefined
    session.startedConnection = undefined
    session.lastSnapshot = undefined
    session.packageVersion = handle.build.packageVersion
    session.autoStart = handle.autoStart
  }

  recordSnapshot(
    session: RuntimeSession,
    snapshot: StageSnapshot,
    connection: WebgalPreviewConnection
  ): void {
    session.lastSnapshot = { connection, snapshot }
    if (session.startupConnection === connection) {
      session.startFeed?.push({
        sceneName: snapshot.sceneName,
        sentenceId: snapshot.sentenceId,
        stageState: snapshot.stageState
      })
    }
  }

  abort(session: RuntimeSession): void {
    session.startupAttemptAbort?.abort(new Error('预览会话已关闭'))
    session.startFeed = undefined
  }

  waitForReady(
    session: RuntimeSession,
    waiters: PreviewRuntimeReadyWaiters
  ): Promise<WebgalPreviewConnection | undefined> {
    const ready = waiters.readyConnection()
    if (ready) return Promise.resolve(ready)
    if (session.released) return Promise.resolve(undefined)
    const { promise, resolve } = Promise.withResolvers<WebgalPreviewConnection | undefined>()
    const timer = setTimeout(() => {
      waiters.removeReadyWaiter(waiter)
      resolve(undefined)
    }, this.timeoutMs)
    const waiter: ReadyWaiter = {
      session,
      resolve: (connection) => {
        clearTimeout(timer)
        waiters.removeReadyWaiter(waiter)
        resolve(connection)
      }
    }
    waiters.addReadyWaiter(waiter)
    return promise
  }

  /**
   * 舞台注册就绪不等于离开语言和标题层。预览宿主在页面内激活真实开始控件，
   * 这里只等待目标入口的真实游戏快照；失败或超时明确返回，不把标题画面当成定位成功。
   */
  ensureStarted(
    session: RuntimeSession,
    connection: WebgalPreviewConnection
  ): Promise<PreviewErrorVO | null> {
    if (!session.autoStart) return Promise.resolve(null)
    if (session.startedConnection === connection) return Promise.resolve(null)
    if (session.startupConnection === connection && session.startup) return session.startup
    session.startupAttemptAbort?.abort(new Error('预览页面已更换'))
    const support = selectCandidateStartSupport({
      packageVersion: session.packageVersion ?? '',
      commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
    })
    if (support !== 'host-autostart') {
      return Promise.resolve(runtimeFailure('engineCapabilityUnavailable'))
    }
    const feed = new CandidateStageFeed()
    const last = session.lastSnapshot
    if (last && last.connection === connection) {
      feed.push({
        sceneName: last.snapshot.sceneName,
        sentenceId: last.snapshot.sentenceId,
        stageState: last.snapshot.stageState
      })
    }
    session.startFeed = feed
    session.startupConnection = connection
    const attempt = new AbortController()
    session.startupAttemptAbort = attempt
    const timer = setTimeout(
      () => attempt.abort(new Error('等待 WebGAL 开始游戏超时')),
      this.startupTimeoutMs
    )
    const record: { promise?: Promise<PreviewErrorVO | null> } = {}
    const startup = (async (): Promise<PreviewErrorVO | null> => {
      try {
        await confirmCandidateGame({
          sceneName: sceneIdentity(session.entryName),
          signal: attempt.signal,
          feed,
          support
        })
        session.startedConnection = connection
        return null
      } catch (error) {
        return this.startupFailureOf(error)
      } finally {
        clearTimeout(timer)
        if (session.startFeed === feed) session.startFeed = undefined
        if (session.startupAttemptAbort === attempt) session.startupAttemptAbort = undefined
        if (session.startup === record.promise) {
          session.startup = undefined
          session.startupConnection = undefined
        }
      }
    })()
    record.promise = startup
    session.startup = startup
    return startup
  }

  private startupFailureOf(error: unknown): PreviewErrorVO {
    if (error instanceof CandidateStartError) {
      return runtimeFailure(
        error.message === '当前引擎不支持开始游戏' ? 'engineCapabilityUnavailable' : 'prepareFailed'
      )
    }
    const message = error instanceof Error ? error.message : ''
    if (message.includes('超时')) return runtimeFailure('commandTimeout')
    if (message.includes('关闭')) return runtimeFailure('sessionClosed')
    return runtimeFailure('prepareFailed')
  }
}
