import { describe, expect, it } from 'vitest'

import {
  AppUpdateApplicationServiceImpl,
  type AppUpdateApplicationDependencies
} from '@application/app-update/services/impl/AppUpdateApplicationServiceImpl'
import type { UpdateInstallAttemptGateway } from '@application/app-update/ports/UpdateInstallAttemptGateway'
import type { UpdateReleaseGateway } from '@application/app-update/ports/UpdateReleaseGateway'
import type { UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { UpdateInstallAttempt } from '@domain/app-update/models/InstallAttempt'
import type { DownloadProgress, ReleaseInfo } from '@domain/app-update/models/UpdateModels'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

class ControlledReleaseGateway implements UpdateReleaseGateway {
  supported = true
  version = '0.1.0'
  releases: Array<ReleaseInfo | null> = []
  checkGate: Deferred | undefined
  downloadGate: Deferred | undefined
  checkError: Error | undefined
  downloadError: Error | undefined
  installError: Error | undefined
  progressEvents: DownloadProgress[] = []
  checkCalls = 0
  downloadCalls = 0
  installCalls = 0

  supportsAutoUpdate(): boolean {
    return this.supported
  }

  currentVersion(): string {
    return this.version
  }

  async checkForUpdate(): Promise<ReleaseInfo | null> {
    this.checkCalls += 1
    if (this.checkGate !== undefined) await this.checkGate.promise
    if (this.checkError !== undefined) throw this.checkError
    return this.releases.shift() ?? null
  }

  async downloadUpdate(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    this.downloadCalls += 1
    for (const progress of this.progressEvents) onProgress(progress)
    if (this.downloadGate !== undefined) await this.downloadGate.promise
    if (this.downloadError !== undefined) throw this.downloadError
  }

  async installUpdate(): Promise<void> {
    this.installCalls += 1
    if (this.installError !== undefined) throw this.installError
  }
}

class MemoryInstallAttemptGateway implements UpdateInstallAttemptGateway {
  attempt: UpdateInstallAttempt | null = null
  recordError: Error | undefined
  clearCalls = 0

  async read(): Promise<UpdateInstallAttempt | null> {
    return this.attempt
  }

  async record(attempt: UpdateInstallAttempt): Promise<void> {
    if (this.recordError !== undefined) throw this.recordError
    this.attempt = attempt
  }

  async clear(): Promise<void> {
    this.clearCalls += 1
    this.attempt = null
  }
}

function createLogger(): LoggerGateway & {
  warnings: Array<{ message: string; context?: LogContext }>
} {
  const warnings: Array<{ message: string; context?: LogContext }> = []
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      warnings.push({ message, ...(context === undefined ? {} : { context }) })
    },
    error: () => undefined
  }
}

function createService(
  options: {
    release?: ControlledReleaseGateway
    attempts?: MemoryInstallAttemptGateway
    previousInstallFailed?: boolean
  } = {}
): {
  service: AppUpdateApplicationServiceImpl
  release: ControlledReleaseGateway
  attempts: MemoryInstallAttemptGateway
} {
  const release = options.release ?? new ControlledReleaseGateway()
  const attempts = options.attempts ?? new MemoryInstallAttemptGateway()
  const dependencies: AppUpdateApplicationDependencies = {
    release,
    installAttempts: attempts,
    logger: createLogger(),
    now: () => Date.UTC(2026, 10, 12, 3, 4, 5),
    ...(options.previousInstallFailed === undefined
      ? {}
      : { previousInstallFailed: options.previousInstallFailed })
  }
  return { service: new AppUpdateApplicationServiceImpl(dependencies), release, attempts }
}

function nextPhase(
  service: AppUpdateApplicationServiceImpl,
  phase: UpdateStatusVO['phase']
): Promise<UpdateStatusVO> {
  const { promise, resolve } = Promise.withResolvers<UpdateStatusVO>()
  const unsubscribe = service.subscribe((status) => {
    if (status.phase !== phase) return
    unsubscribe()
    resolve(status)
  })
  return promise
}

function nextImmediate(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}

async function downloadAvailableUpdate(
  service: AppUpdateApplicationServiceImpl,
  release: ControlledReleaseGateway
): Promise<void> {
  release.releases.push({ version: '0.1.1' })
  await service.checkForUpdate({ reason: 'manual' })
  const downloaded = nextPhase(service, 'downloaded')
  await service.downloadUpdate({})
  await downloaded
}

describe('应用更新编排', () => {
  it('发现严格新版本时进入 available，最新或旧版本回到 idle', async () => {
    const { service, release } = createService()
    release.releases.push({ version: '0.1.10' }, { version: '0.1.0' }, { version: '0.0.9' })

    const available = await service.checkForUpdate({ reason: 'manual' })
    expect(available).toEqual({
      phase: 'available',
      currentVersion: '0.1.0',
      release: { version: '0.1.10' }
    })
    expect((await service.readStatus({})).phase).toBe('available')

    expect(await service.checkForUpdate({ reason: 'background' })).toEqual({
      phase: 'idle',
      currentVersion: '0.1.0'
    })
    expect((await service.readStatus({})).phase).toBe('idle')

    expect(await service.checkForUpdate({ reason: 'manual' })).toEqual({
      phase: 'idle',
      currentVersion: '0.1.0'
    })
  })

  it('0.1.9 到 0.1.10 识别为严格更新', async () => {
    const release = new ControlledReleaseGateway()
    release.version = '0.1.9'
    release.releases.push({ version: '0.1.10' })
    const { service } = createService({ release })

    expect(await service.checkForUpdate({ reason: 'background' })).toEqual({
      phase: 'available',
      currentVersion: '0.1.9',
      release: { version: '0.1.10' }
    })
  })

  it('发布源版本格式非法时映射 source-unavailable，不伪装成最新', async () => {
    const { service, release } = createService()
    release.releases.push({ version: '0.1' })

    await expect(service.checkForUpdate({ reason: 'manual' })).rejects.toMatchObject({
      code: 5102,
      message: '检查更新失败，请检查网络后重试'
    })
    expect(await service.readStatus({})).toMatchObject({
      phase: 'failed',
      supported: true,
      failure: { kind: 'source-unavailable' }
    })
  })

  it('运行形态不支持时以 invalidConfig 拒绝并保留 supported=false', async () => {
    const release = new ControlledReleaseGateway()
    release.supported = false
    const { service } = createService({ release })

    expect((await service.readStatus({})).supported).toBe(false)
    await expect(service.checkForUpdate({ reason: 'manual' })).rejects.toMatchObject({
      code: 5101,
      message: '当前运行形态不支持应用内更新'
    })
    expect(await service.readStatus({})).toMatchObject({
      phase: 'failed',
      failure: { kind: 'unsupported' }
    })
  })

  it('检查进行中拒绝并发检查、下载和安装，且不破坏原状态', async () => {
    const { service, release } = createService()
    const gate = deferred()
    release.checkGate = gate
    release.releases.push({ version: '0.1.1' })

    const checking = service.checkForUpdate({ reason: 'manual' })
    expect(await service.readStatus({})).toMatchObject({ phase: 'checking' })

    await expect(service.checkForUpdate({ reason: 'background' })).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    await expect(service.downloadUpdate({})).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    await expect(service.installUpdate({})).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    expect((await service.readStatus({})).phase).toBe('checking')

    gate.resolve()
    expect(await checking).toMatchObject({ phase: 'available' })
    expect((await service.readStatus({})).phase).toBe('available')
  })

  it('下载立即返回 downloading，进度取整、钳制且同次下载不倒退', async () => {
    const { service, release } = createService()
    release.releases.push({ version: '0.1.1' })
    await service.checkForUpdate({ reason: 'manual' })

    const gate = deferred()
    release.downloadGate = gate
    release.progressEvents = [
      { percent: 12.4, transferred: 12, total: 100, bytesPerSecond: 8 },
      { percent: 9, transferred: 9, total: 100, bytesPerSecond: 8 },
      { percent: 55.6, transferred: 56, total: 100, bytesPerSecond: 8 }
    ]
    const statuses: UpdateStatusVO[] = []
    service.subscribe((status) => {
      statuses.push(status)
    })

    const started = await service.downloadUpdate({})
    expect(started.phase).toBe('downloading')
    expect(started.progress).toEqual({
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0
    })
    expect(release.downloadCalls).toBe(1)

    expect((await service.readStatus({})).progress).toEqual({
      percent: 56,
      transferred: 56,
      total: 100,
      bytesPerSecond: 8
    })

    await expect(service.checkForUpdate({ reason: 'manual' })).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    await expect(service.installUpdate({})).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })

    const downloaded = nextPhase(service, 'downloaded')
    gate.resolve()
    const completed = await downloaded
    expect(completed.progress?.percent).toBe(100)
    expect(statuses.map((status) => status.phase)).toEqual([
      'downloading',
      'downloading',
      'downloading',
      'downloading',
      'downloaded'
    ])
  })

  it('总量未知时进度保持不确定态', async () => {
    const { service, release } = createService()
    release.releases.push({ version: '0.1.1' })
    await service.checkForUpdate({ reason: 'manual' })
    const gate = deferred()
    release.downloadGate = gate
    release.progressEvents = [{ percent: 42, transferred: 42, total: 0, bytesPerSecond: 0 }]

    await service.downloadUpdate({})
    expect((await service.readStatus({})).progress).toEqual({
      percent: 0,
      transferred: 42,
      total: 0,
      bytesPerSecond: 0
    })

    gate.resolve()
    const completed = await nextPhase(service, 'downloaded')
    expect(completed.progress).toEqual({
      percent: 0,
      transferred: 42,
      total: 0,
      bytesPerSecond: 0
    })
  })

  it('下载网关同步抛错时立即返回的仍是 downloading 快照', async () => {
    const { service, release } = createService()
    release.releases.push({ version: '0.1.1' })
    await service.checkForUpdate({ reason: 'manual' })
    release.downloadUpdate = () => {
      throw new Error('synchronous setup failure')
    }
    const failed = nextPhase(service, 'failed')

    const started = await service.downloadUpdate({})
    expect(started).toEqual({
      phase: 'downloading',
      currentVersion: '0.1.0',
      supported: true,
      release: { version: '0.1.1' },
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    })
    expect(await failed).toMatchObject({
      phase: 'failed',
      failure: { kind: 'download-failed', message: '更新下载失败，请重试' }
    })
  })

  it('下载异步失败进入 failed，重新检查后可再次下载', async () => {
    const { service, release } = createService()
    release.releases.push({ version: '0.1.1' })
    await service.checkForUpdate({ reason: 'manual' })
    release.downloadError = new Error('network broke')

    const failed = nextPhase(service, 'failed')
    await service.downloadUpdate({})
    expect(await failed).toMatchObject({
      phase: 'failed',
      failure: { kind: 'download-failed', message: '更新下载失败，请重试' }
    })

    release.downloadError = undefined
    release.releases.push({ version: '0.1.1' })
    expect(await service.checkForUpdate({ reason: 'manual' })).toMatchObject({
      phase: 'available'
    })
    const downloaded = nextPhase(service, 'downloaded')
    await service.downloadUpdate({})
    await downloaded
    expect(release.downloadCalls).toBe(2)
  })

  it('未下载完成时安装以 invalid-state 拒绝', async () => {
    const { service, release, attempts } = createService()
    release.releases.push({ version: '0.1.1' })
    await service.checkForUpdate({ reason: 'manual' })

    await expect(service.installUpdate({})).rejects.toMatchObject({
      code: 4103,
      message: '更新状态已变化，请重新检查'
    })
    expect(attempts.attempt).toBeNull()
    expect((await service.readStatus({})).failure?.kind).toBe('invalid-state')
  })

  it('安装先记录跨启动标记，记录成功后在下一事件循环调用安装且正常返回不清标记', async () => {
    const { service, release, attempts } = createService()
    await downloadAvailableUpdate(service, release)
    const installing = nextPhase(service, 'installing')

    await service.installUpdate({})
    expect(release.installCalls).toBe(0)
    expect(await installing).toMatchObject({ phase: 'installing' })
    expect(attempts.attempt).toEqual({
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
      attemptedAt: '2026-11-12T03:04:05.000Z'
    })

    await nextImmediate()
    expect(release.installCalls).toBe(1)
    expect(attempts.attempt).not.toBeNull()
    expect(attempts.clearCalls).toBe(0)
    expect((await service.readStatus({})).phase).toBe('installing')
  })

  it('安装标记写入期间拒绝并发操作，写入失败按 install-failed 拒绝且不启动安装', async () => {
    const { service, release, attempts } = createService()
    await downloadAvailableUpdate(service, release)
    const recordGate = deferred()
    attempts.record = async () => {
      await recordGate.promise
      throw new Error('disk unavailable')
    }

    const installing = service.installUpdate({})
    await expect(service.checkForUpdate({ reason: 'manual' })).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    await expect(service.downloadUpdate({})).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    await expect(service.installUpdate({})).rejects.toMatchObject({
      code: 4103,
      message: '更新正在进行'
    })
    expect((await service.readStatus({})).phase).toBe('downloaded')

    recordGate.resolve()
    await expect(installing).rejects.toMatchObject({
      code: 5103,
      message: '更新安装失败，请重新下载或手动安装'
    })
    expect(release.installCalls).toBe(0)
    expect(attempts.attempt).toBeNull()
    expect((await service.readStatus({})).failure?.kind).toBe('install-failed')
  })

  it('可观察的安装失败推送 failed 并清理安装标记', async () => {
    const { service, release, attempts } = createService()
    await downloadAvailableUpdate(service, release)
    release.installError = new Error('installer failed')
    const failed = nextPhase(service, 'failed')

    await service.installUpdate({})
    await nextImmediate()

    expect(await failed).toMatchObject({
      phase: 'failed',
      failure: { kind: 'install-failed', message: '更新安装失败，请重新下载或手动安装' }
    })
    expect(attempts.clearCalls).toBe(1)
    expect(attempts.attempt).toBeNull()
  })

  it('上次安装未完成时以 failed 初始状态提示一次', async () => {
    const { service } = createService({ previousInstallFailed: true })

    expect(await service.readStatus({})).toMatchObject({
      phase: 'failed',
      currentVersion: '0.1.0',
      supported: true,
      failure: {
        kind: 'install-failed',
        message: '上次更新未能完成，请重新下载或手动安装'
      }
    })
  })

  it('订阅者异常不影响其他订阅者和状态推进', async () => {
    const release = new ControlledReleaseGateway()
    release.releases.push({ version: '0.1.1' })
    const logger = createLogger()
    const dependencies: AppUpdateApplicationDependencies = {
      release,
      installAttempts: new MemoryInstallAttemptGateway(),
      logger,
      now: () => Date.UTC(2026, 10, 12, 3, 4, 5)
    }
    const isolated = new AppUpdateApplicationServiceImpl(dependencies)
    isolated.subscribe(() => {
      throw new Error('subscriber broke')
    })
    const seen: UpdateStatusVO['phase'][] = []
    isolated.subscribe((status) => {
      seen.push(status.phase)
    })

    await isolated.checkForUpdate({ reason: 'manual' })

    expect(seen).toEqual(['checking', 'available'])
    expect(logger.warnings.map((warning) => warning.message)).toContain('应用更新状态订阅者异常')
  })
})
