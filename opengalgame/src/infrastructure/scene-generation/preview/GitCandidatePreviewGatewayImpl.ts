import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type {
  CloseSceneGenerationCandidatePreviewDTO,
  OpenSceneGenerationCandidatePreviewDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  CandidatePreviewOpenContext,
  SceneCandidatePreviewGateway,
  SceneGenerationCandidatePreviewOpen
} from '@application/scene-generation/ports/SceneCandidatePreviewGateway'
import type {
  CandidatePreviewSessionRecord,
  CandidatePreviewSessionState
} from '@application/scenes/models/CandidatePreviewSessionRecord'
import type { CandidatePreviewSessionLookup } from '@application/scenes/ports/CandidatePreviewSessionLookup'
import type {
  SceneGenerationCandidatePreviewEventVO,
  SceneGenerationCandidatePreviewListener
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { assertRelativePath } from '@infrastructure/git/containedPath'
import { readCommitFiles, resolveRefIfExists } from '@infrastructure/git/objects/gitTree'
import { createRequire } from 'node:module'
import { WebgalPreviewRuntimeAdapter } from '@infrastructure/webgal/preview/WebgalPreviewRuntimeAdapter'
import {
  CandidateStageFeed,
  confirmCandidateGame,
  selectCandidateStartSupport,
  type CandidateTrustedInput,
  type CandidateTrustedInputSource
} from '@infrastructure/webgal/compatibility/candidateGameStart'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'

const require = createRequire(import.meta.url)
const SESSION_TTL_MS = 15 * 60 * 1000

const EMPTY_METADATA: readonly string[] = []

type PreviewSession = {
  projectId: string
  sceneId: string
  sceneName: string
  operationId: string
  threadId: string
  candidateSnapshotId: string
  entryFile: string
  root: string
  host?: WebgalRuntimeHostImpl
  adapter?: WebgalPreviewRuntimeAdapter
  expiresAt: number
  timer?: NodeJS.Timeout
  state: CandidatePreviewSessionState
  eventSequence: number
  stage?: AbortController
  stageResult?: Promise<void>
}

/**
 * 从已发布候选裸 Git 修订建立独立只读预览。
 * 不读取可变工作区，也不在修订缺失时回退正式工程。
 * 页面地址只证明宿主已启动；就绪必须是目标入口的真实游戏状态。
 */
export class GitCandidatePreviewGatewayImpl
  implements SceneCandidatePreviewGateway, CandidatePreviewSessionLookup
{
  private readonly sessions: Record<string, PreviewSession> = {}
  private readonly listeners = new Set<SceneGenerationCandidatePreviewListener>()
  /** 会话释放后仍保留最后事实，供稍后订阅的渲染端补投。 */
  private readonly lastEvents = new Map<string, SceneGenerationCandidatePreviewEventVO>()

  constructor(
    private readonly files: AiProjectFileSystemImpl,
    private readonly stateRoot: string,
    private readonly now: () => number = Date.now,
    private readonly engineRoot = dirname(require.resolve('webgal-engine/package.json')),
    private readonly stageTimeoutMs = 12_000,
    private readonly start: {
      readonly trustedInput?: CandidateTrustedInputSource
      readonly sessionTtlMs?: number
      readonly logger?: LoggerGateway
    } = {}
  ) {}

  async openPublishedCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO,
    context: CandidatePreviewOpenContext
  ): Promise<SceneGenerationCandidatePreviewOpen> {
    const entryFile = assertRelativePath(context.entryFile)
    if (context.sceneName.trim() === '') {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选预览入口无效' })
    }
    const workspace = this.files.locateWorkspace(request)
    const published = await resolveRefIfExists(
      { gitdir: workspace.revisionGitDir },
      `refs/opengalgame/revisions/${request.candidateSnapshotId}`
    )
    if (published !== request.candidateSnapshotId) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    }
    const files = await readCommitFiles(
      { gitdir: workspace.revisionGitDir },
      request.candidateSnapshotId
    )
    const sessionId = randomUUID()
    const root = join(this.stateRoot, 'scene-generation', 'previews', sessionId)
    const host = new WebgalRuntimeHostImpl({ projectRoot: root, engineRoot: this.engineRoot })
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: this.stageTimeoutMs })
    const stage = new AbortController()
    try {
      await this.materialize(root, workspace.rootDirectory, files)
      const handle = await host.start()
      const ttl = this.start.sessionTtlMs ?? SESSION_TTL_MS
      const expiresAt = this.now() + ttl
      const timer = setTimeout(() => {
        void this.expire(sessionId).catch((error: unknown) => {
          this.logCleanupFailure(session, error)
        })
      }, ttl)
      timer.unref?.()
      const session: PreviewSession = {
        projectId: request.projectId,
        sceneId: request.sceneId,
        sceneName: context.sceneName,
        operationId: request.operationId,
        threadId: request.threadId,
        candidateSnapshotId: request.candidateSnapshotId,
        entryFile,
        root,
        host,
        adapter,
        expiresAt,
        timer,
        state: 'active',
        eventSequence: 0,
        stage
      }
      const stageInput = this.start.trustedInput?.({
        stageUrl: `${handle.baseUrl}/`,
        signal: stage.signal
      })
      const stageResult = this.observeStage(sessionId, session, stageInput ?? null)
      session.stageResult = stageResult
      this.sessions[sessionId] = session
      return {
        preview: {
          previewSessionId: sessionId,
          candidateSnapshotId: request.candidateSnapshotId,
          url:
            stageInput?.stagePageUrl ??
            `${handle.baseUrl}/?session=${encodeURIComponent(sessionId)}`,
          expiresAt: new Date(expiresAt).toISOString()
        },
        stage: stageResult
      }
    } catch (error) {
      stage.abort()
      await adapter.dispose().catch(() => undefined)
      await host.dispose().catch(() => undefined)
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof AppException) throw error
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '候选预览暂时不可用',
        cause: error
      })
    }
  }

  async closeCandidatePreview(request: CloseSceneGenerationCandidatePreviewDTO): Promise<void> {
    const session = this.sessions[request.previewSessionId]
    if (
      !session ||
      session.projectId !== request.projectId ||
      session.sceneId !== request.sceneId ||
      session.operationId !== request.operationId
    ) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '预览会话不存在或不属于当前操作'
      })
    }
    await this.release(request.previewSessionId)
  }

  async invalidateCandidatePreviewSessions(scope: {
    projectId: string
    sceneId: string
    operationId: string
    candidateSnapshotId: string
  }): Promise<void> {
    const matches = Object.entries(this.sessions).filter(
      ([, session]) =>
        session.projectId === scope.projectId &&
        session.sceneId === scope.sceneId &&
        session.operationId === scope.operationId &&
        session.candidateSnapshotId === scope.candidateSnapshotId
    )
    const failures: unknown[] = []
    for (const [sessionId] of matches) {
      try {
        await this.release(sessionId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '旧候选预览没能释放',
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures)
      })
    }
  }

  async close(): Promise<void> {
    await Promise.all(Object.keys(this.sessions).map((sessionId) => this.release(sessionId, false)))
    this.lastEvents.clear()
  }

  subscribeCandidatePreviewEvents(listener: SceneGenerationCandidatePreviewListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 返回会话最后一个真实舞台事实。
   * 打开返回后、渲染端订阅前到达的事件也保留；没有事件时返回 undefined。
   */
  readCandidatePreviewEvent(
    previewSessionId: string
  ): SceneGenerationCandidatePreviewEventVO | undefined {
    return this.lastEvents.get(previewSessionId)
  }

  findCandidatePreviewSession(previewSessionId: string): CandidatePreviewSessionRecord | undefined {
    const session = this.sessions[previewSessionId]
    if (!session) return undefined
    const expired = session.state === 'expired' || session.expiresAt <= this.now()
    return {
      previewSessionId,
      projectId: session.projectId,
      sceneId: session.sceneId,
      sceneName: session.sceneName,
      candidateSnapshotId: session.candidateSnapshotId,
      projectRoot: session.root,
      entryFile: session.entryFile,
      metadataFiles: EMPTY_METADATA,
      expiresAt: new Date(session.expiresAt).toISOString(),
      state: expired ? 'expired' : 'active'
    }
  }

  private async materialize(
    root: string,
    mutableWorkspace: string,
    files: readonly { relativePath: string; bytes: Uint8Array }[]
  ): Promise<void> {
    const mutable = resolve(mutableWorkspace)
    if (resolve(root) === mutable || relative(mutable, root) === '') {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '预览不能使用可变候选工作区' })
    }
    await mkdir(root, { recursive: true })
    const rootReal = await realpath(root)
    for (const file of files) {
      const safe = assertRelativePath(file.relativePath)
      const target = join(rootReal, ...safe.split('/'))
      const fromRoot = relative(rootReal, target).replaceAll('\\', '/')
      if (fromRoot.startsWith('../') || fromRoot === '..') {
        throw new AppException({ code: ErrorCodes.forbidden, msg: '候选修订路径超出预览范围' })
      }
      await mkdir(dirname(target), { recursive: true })
      const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (stats?.isSymbolicLink()) {
        throw new AppException({ code: ErrorCodes.forbidden, msg: '候选预览拒绝符号链接' })
      }
      await writeFile(target, file.bytes, { flag: 'wx' })
    }
  }

  private async release(sessionId: string, notify = true): Promise<void> {
    const session = this.sessions[sessionId]
    if (!session) return
    delete this.sessions[sessionId]
    clearTimeout(session.timer)
    session.stage?.abort()
    if (notify) this.publishInvalidated(sessionId, session)
    await this.disposeResources(session, true)
  }

  private async expire(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId]
    if (!session || session.state === 'expired') return
    clearTimeout(session.timer)
    session.timer = undefined
    session.state = 'expired'
    session.stage?.abort()
    try {
      await this.disposeResources(session, true)
    } catch (error) {
      this.logCleanupFailure(session, error)
    }
  }

  private logCleanupFailure(session: PreviewSession, error: unknown): void {
    this.start.logger?.error('候选运行到期清理未完成，已保留候选', {
      operationId: session.operationId,
      projectId: session.projectId,
      stage: 'candidate-preview-expire',
      errorCode: error instanceof AppException ? error.code : ErrorCodes.internalError
    })
  }

  private async disposeResources(session: PreviewSession, removeRoot: boolean): Promise<void> {
    const failures: unknown[] = []
    const adapter = session.adapter
    const host = session.host
    session.adapter = undefined
    session.host = undefined
    session.stage = undefined
    if (adapter) {
      try {
        await adapter.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (host) {
      try {
        await host.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (removeRoot) {
      try {
        await rm(session.root, { recursive: true, force: true })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '候选预览资源没能释放',
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures)
      })
    }
  }

  /**
   * 标题、语言和注册快照都不能就绪。公开协议没有候选启动命令时，
   * 只有可信输入之后的真实游戏快照才发布 ready。
   * 运行到期或关闭会中止等待，迟到结果不再发布。
   */
  private observeStage(
    sessionId: string,
    session: PreviewSession,
    stageInput: CandidateTrustedInput | null
  ): Promise<void> {
    const adapter = session.adapter
    const signal = session.stage?.signal
    if (!adapter || !signal) return Promise.resolve()
    const feed = new CandidateStageFeed()
    const stopSnapshots = adapter.onStageSnapshot((snapshot) => feed.push(snapshot))
    const stopCommands = adapter.onSentCommand((command) => {
      if (
        command === 'preview.command.sync-scene' ||
        command === 'preview.command.run-scene-content'
      ) {
        feed.fail(new Error('候选预览不能定位'))
      }
    })
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(new Error('等待 WebGAL 舞台状态超时')),
      this.stageTimeoutMs
    )
    const onSessionAbort = (): void => timeout.abort(signal.reason)
    signal.addEventListener('abort', onSessionAbort, { once: true })
    const finish = async (): Promise<void> => {
      try {
        const packageVersion = await this.enginePackageVersion()
        await confirmCandidateGame({
          sceneName: session.sceneName,
          signal: timeout.signal,
          feed,
          support: selectCandidateStartSupport({
            packageVersion,
            commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
          }),
          input: stageInput
        })
        const current = this.sessions[sessionId]
        if (!current || current !== session || current.state !== 'active' || signal.aborted) return
        // 可信输入只负责开始游戏，标题层的进入游戏标志仍为 false；
        // 引擎只在 isEnterGame 为真时播放 BGM，就绪前补上这个界面标志。
        // 降级：该标志只影响 BGM 演出，设置失败不阻断候选就绪，但必须留下诊断。
        try {
          await adapter.setComponentVisibility({ isEnterGame: true }, timeout.signal)
        } catch (error: unknown) {
          this.start.logger?.warn('候选预览进入游戏标志设置失败，BGM 不会自动播放', {
            operationId: session.operationId,
            projectId: session.projectId,
            stage: 'candidate-preview-enter-game',
            errorCode: error instanceof AppException ? error.code : ErrorCodes.internalError,
            ...(error instanceof Error ? { errorName: error.name } : {})
          })
        }
        if (signal.aborted) return
        this.publish(sessionId, session, { type: 'ready', message: '游戏已就绪' })
      } catch (error: unknown) {
        const current = this.sessions[sessionId]
        if (!current || current !== session || current.state !== 'active' || signal.aborted) return
        this.publish(sessionId, session, {
          type: 'stageFailed',
          message: stageFailureMessage(error)
        })
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onSessionAbort)
        stopSnapshots()
        stopCommands()
      }
    }
    return finish()
  }

  private async enginePackageVersion(): Promise<string> {
    try {
      const document = JSON.parse(
        await readFile(join(this.engineRoot, 'package.json'), 'utf8')
      ) as {
        version?: unknown
      }
      return typeof document.version === 'string' ? document.version : ''
    } catch {
      return ''
    }
  }

  private publishInvalidated(sessionId: string, session: PreviewSession): void {
    this.publish(sessionId, session, { type: 'invalidated' })
  }

  private publish(
    sessionId: string,
    session: PreviewSession,
    event: { type: 'ready' | 'stageFailed'; message?: string } | { type: 'invalidated' }
  ): void {
    session.eventSequence += 1
    const payload: SceneGenerationCandidatePreviewEventVO =
      event.type === 'invalidated'
        ? {
            type: 'invalidated',
            sequence: session.eventSequence,
            projectId: session.projectId,
            sceneId: session.sceneId,
            previewSessionId: sessionId,
            candidateSnapshotId: session.candidateSnapshotId
          }
        : {
            type: event.type,
            sequence: session.eventSequence,
            projectId: session.projectId,
            sceneId: session.sceneId,
            previewSessionId: sessionId,
            candidateSnapshotId: session.candidateSnapshotId,
            ...(event.message ? { message: event.message } : {})
          }
    this.lastEvents.set(sessionId, payload)
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch {
        // 单个监听失败不阻止其余订阅，也不把技术错误带回舞台。
      }
    }
  }
}

function stageFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return '游戏加载失败'
  if (
    error.name === 'CandidateStartError' ||
    error.message === '当前引擎不支持开始游戏' ||
    error.message === '宿主无法开始游戏' ||
    error.message === '游戏没有离开当前画面' ||
    error.message === '游戏没有进入场景'
  ) {
    return error.message
  }
  if (error.message.includes('尚未注册')) return '游戏尚未注册'
  if (error.message.includes('超时') || error.message.includes('尚未就绪')) return '游戏加载超时'
  if (error.message.includes('断开')) return '游戏连接已断开'
  return '游戏加载失败'
}
