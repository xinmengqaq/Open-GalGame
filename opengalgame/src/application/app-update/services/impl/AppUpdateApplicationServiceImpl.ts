import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { compareAppVersion } from '@domain/app-update/models/AppVersion'
import type { UpdateInstallAttempt } from '@domain/app-update/models/InstallAttempt'
import type {
  DownloadProgress,
  ReleaseInfo,
  UpdateFailureKind,
  UpdatePhase
} from '@domain/app-update/models/UpdateModels'

import type {
  CheckForUpdateDTO,
  DownloadUpdateDTO,
  InstallUpdateDTO,
  ReadUpdateStatusDTO
} from '../../dto/AppUpdateDTO'
import type { UpdateInstallAttemptGateway } from '../../ports/UpdateInstallAttemptGateway'
import type { UpdateReleaseGateway } from '../../ports/UpdateReleaseGateway'
import type { ReleaseSummaryVO, UpdateCheckVO, UpdateStatusVO } from '../../vo/AppUpdateVO'
import type { AppUpdateApplicationService } from '../AppUpdateApplicationService'

export interface AppUpdateApplicationDependencies {
  readonly release: UpdateReleaseGateway
  readonly installAttempts: UpdateInstallAttemptGateway
  readonly logger: LoggerGateway
  readonly now: () => number
  /** 上次安装记录经启动核对后得出的失败结论。 */
  readonly previousInstallFailed?: boolean
}

type UpdateFailure = {
  kind: UpdateFailureKind
  message: string
}

type UpdateState = {
  phase: UpdatePhase
  release?: ReleaseInfo
  progress?: DownloadProgress
  failure?: UpdateFailure
}

const updateFailureFacts: Record<UpdateFailureKind, { code: number; message: string }> = {
  unsupported: { code: ErrorCodes.invalidConfig, message: '当前运行形态不支持应用内更新' },
  'source-unavailable': {
    code: ErrorCodes.communicationFailed,
    message: '检查更新失败，请检查网络后重试'
  },
  'download-failed': { code: ErrorCodes.internalError, message: '更新下载失败，请重试' },
  'install-failed': {
    code: ErrorCodes.internalError,
    message: '更新安装失败，请重新下载或手动安装'
  },
  'invalid-state': {
    code: ErrorCodes.operationConflict,
    message: '更新状态已变化，请重新检查'
  }
}

const previousInstallFailureMessage = '上次更新未能完成，请重新下载或手动安装'
const initialProgress: DownloadProgress = {
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0
}

type UpdateOperation = 'check' | 'download' | 'install'

/**
 * 单状态源的更新编排。
 * 检查、下载、安装互斥；下载在后台结算，安装先记录跨启动标记再退出。
 */
export class AppUpdateApplicationServiceImpl implements AppUpdateApplicationService {
  private readonly currentVersion: string
  private readonly supported: boolean
  private readonly listeners = new Set<(status: UpdateStatusVO) => void>()
  private state: UpdateState
  private installAttemptRecording = false

  constructor(private readonly deps: AppUpdateApplicationDependencies) {
    this.currentVersion = deps.release.currentVersion()
    this.supported = deps.release.supportsAutoUpdate()
    this.state = deps.previousInstallFailed
      ? {
          phase: 'failed',
          failure: { kind: 'install-failed', message: previousInstallFailureMessage }
        }
      : { phase: 'idle' }
  }

  async checkForUpdate(request: CheckForUpdateDTO): Promise<UpdateCheckVO> {
    void request
    if (this.isBusy()) throw this.busyFailure()
    if (!this.supported) throw this.fail('unsupported', 'check')

    this.transition({ phase: 'checking' })
    try {
      const release = await this.deps.release.checkForUpdate()
      if (release !== null && compareAppVersion(this.currentVersion, release.version) < 0) {
        this.transition({ phase: 'available', release })
        return {
          phase: 'available',
          currentVersion: this.currentVersion,
          release: toReleaseSummary(release)
        }
      }
      this.transition({ phase: 'idle' })
      return { phase: 'idle', currentVersion: this.currentVersion }
    } catch (error) {
      throw this.fail('source-unavailable', 'check', error)
    }
  }

  async downloadUpdate(request: DownloadUpdateDTO): Promise<UpdateStatusVO> {
    void request
    if (this.isBusy()) throw this.busyFailure()
    if (this.state.phase !== 'available' || this.state.release === undefined) {
      throw this.fail('invalid-state', 'download')
    }

    const release = this.state.release
    this.transition({
      phase: 'downloading',
      release,
      progress: { ...initialProgress }
    })
    queueMicrotask(() => {
      void this.runDownload()
    })
    return this.snapshot()
  }

  async installUpdate(request: InstallUpdateDTO): Promise<void> {
    void request
    if (this.isBusy()) throw this.busyFailure()
    if (this.state.phase !== 'downloaded' || this.state.release === undefined) {
      throw this.fail('invalid-state', 'install')
    }

    const release = this.state.release
    const attempt: UpdateInstallAttempt = {
      fromVersion: this.currentVersion,
      toVersion: release.version,
      attemptedAt: new Date(this.deps.now()).toISOString()
    }

    this.installAttemptRecording = true
    try {
      await this.deps.installAttempts.record(attempt)
    } catch (error) {
      this.installAttemptRecording = false
      throw this.fail('install-failed', 'install', error)
    }
    this.installAttemptRecording = false
    this.transition({ phase: 'installing', release })
    setImmediate(() => {
      void this.runInstall()
    })
  }

  async readStatus(request: ReadUpdateStatusDTO): Promise<UpdateStatusVO> {
    void request
    return this.snapshot()
  }

  subscribe(listener: (status: UpdateStatusVO) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async runDownload(): Promise<void> {
    let lastPercent = 0
    const onProgress = (progress: DownloadProgress): void => {
      if (this.state.phase !== 'downloading') return
      const next = normalizeProgress(progress, lastPercent)
      lastPercent = next.percent
      this.state = { ...this.state, progress: next }
      this.publish()
    }

    try {
      await this.deps.release.downloadUpdate(onProgress)
      if (this.state.phase !== 'downloading') return
      const progress = this.state.progress
      this.transition({
        phase: 'downloaded',
        ...(this.state.release === undefined ? {} : { release: this.state.release }),
        ...(progress === undefined
          ? {}
          : { progress: { ...progress, percent: progress.total > 0 ? 100 : 0 } })
      })
    } catch (error) {
      if (this.state.phase !== 'downloading') return
      this.fail('download-failed', 'download', error)
    }
  }

  private async runInstall(): Promise<void> {
    try {
      await this.deps.release.installUpdate()
    } catch (error) {
      if (this.state.phase !== 'installing') return
      this.fail('install-failed', 'install', error)
      try {
        await this.deps.installAttempts.clear()
      } catch (clearError) {
        const errorName = errorNameOf(clearError)
        this.deps.logger.warn('清理更新安装记录失败', {
          ...(errorName === undefined ? {} : { errorName })
        })
      }
    }
  }

  private isBusy(): boolean {
    return (
      this.installAttemptRecording ||
      this.state.phase === 'checking' ||
      this.state.phase === 'downloading' ||
      this.state.phase === 'installing'
    )
  }

  private busyFailure(): AppException {
    return new AppException({ code: ErrorCodes.operationConflict, msg: '更新正在进行' })
  }

  private fail(kind: UpdateFailureKind, operation: UpdateOperation, cause?: unknown): AppException {
    const { code, message } = updateFailureFacts[kind]
    this.transition({ phase: 'failed', failure: { kind, message } })
    const errorName = errorNameOf(cause)
    this.deps.logger.warn('应用更新操作失败', {
      stage: operation,
      category: kind,
      errorCode: code,
      ...(errorName === undefined ? {} : { errorName })
    })
    return new AppException({
      code,
      msg: message,
      ...(cause === undefined ? {} : { cause })
    })
  }

  private transition(state: UpdateState): void {
    this.state = state
    this.publish()
  }

  private publish(): void {
    const status = this.snapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch (error) {
        const errorName = errorNameOf(error)
        this.deps.logger.warn('应用更新状态订阅者异常', {
          ...(errorName === undefined ? {} : { errorName })
        })
      }
    }
  }

  private snapshot(): UpdateStatusVO {
    return {
      phase: this.state.phase,
      currentVersion: this.currentVersion,
      supported: this.supported,
      ...(this.state.release === undefined
        ? {}
        : { release: toReleaseSummary(this.state.release) }),
      ...(this.state.progress === undefined ? {} : { progress: { ...this.state.progress } }),
      ...(this.state.failure === undefined ? {} : { failure: { ...this.state.failure } })
    }
  }
}

function toReleaseSummary(release: ReleaseInfo): ReleaseSummaryVO {
  return {
    version: release.version,
    ...(release.releaseName === undefined ? {} : { releaseName: release.releaseName }),
    ...(release.releaseNotes === undefined ? {} : { releaseNotes: release.releaseNotes }),
    ...(release.releasedAt === undefined ? {} : { releasedAt: release.releasedAt })
  }
}

function normalizeProgress(progress: DownloadProgress, previousPercent: number): DownloadProgress {
  const total = nonNegative(progress.total)
  const rawPercent = total > 0 ? Math.round(nonNegative(progress.percent)) : 0
  const percent = Math.max(previousPercent, Math.min(100, rawPercent))
  return {
    percent,
    transferred: nonNegative(progress.transferred),
    total,
    bytesPerSecond: nonNegative(progress.bytesPerSecond)
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function errorNameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}
