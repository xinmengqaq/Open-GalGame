import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { UpdateReleaseGateway } from '@application/app-update/ports/UpdateReleaseGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { DownloadProgress, ReleaseInfo } from '@domain/app-update/models/UpdateModels'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { app } from 'electron'

const unsupportedMessage = '当前运行形态不支持应用内更新'

/**
 * 真实 electron-updater 发布源。
 * 发布地址只来自安装包内的 app-update.yml，不在运行时接收地址；库自身日志关闭，只向应用 logger 记录分类。
 */
export class ElectronUpdaterGatewayImpl implements UpdateReleaseGateway {
  private activeProgressListener: ((info: ProgressInfo) => void) | undefined

  constructor(private readonly logger: LoggerGateway) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    autoUpdater.on('error', this.handleUpdaterError)
  }

  supportsAutoUpdate(): boolean {
    return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
  }

  currentVersion(): string {
    return app.getVersion()
  }

  async checkForUpdate(): Promise<ReleaseInfo | null> {
    this.requireSupported()
    const result = await autoUpdater.checkForUpdates()
    if (result === null) return null
    const info = result.updateInfo
    const releaseName = normalizeText(info.releaseName)
    const releaseNotes = normalizeReleaseNotes(info.releaseNotes)
    return {
      version: info.version,
      ...(releaseName === undefined ? {} : { releaseName }),
      ...(releaseNotes === undefined ? {} : { releaseNotes }),
      ...(info.releaseDate === '' ? {} : { releasedAt: info.releaseDate })
    }
  }

  async downloadUpdate(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    this.requireSupported()
    const listener = (info: ProgressInfo): void => {
      onProgress({
        percent: info.percent,
        transferred: info.transferred,
        total: info.total,
        bytesPerSecond: info.bytesPerSecond
      })
    }
    this.activeProgressListener = listener
    autoUpdater.on('download-progress', listener)
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.logSafely('更新下载失败', error)
      throw error
    } finally {
      autoUpdater.off('download-progress', listener)
      this.activeProgressListener = undefined
    }
  }

  async installUpdate(): Promise<void> {
    this.requireSupported()
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch (error) {
      this.logSafely('更新安装无法启动', error)
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '更新安装失败，请重新下载或手动安装',
        cause: error
      })
    }
  }

  /** 释放库事件监听，避免窗口重载或退出阶段留下悬挂回调。 */
  dispose(): void {
    autoUpdater.off('error', this.handleUpdaterError)
    if (this.activeProgressListener !== undefined) {
      autoUpdater.off('download-progress', this.activeProgressListener)
      this.activeProgressListener = undefined
    }
  }

  private readonly handleUpdaterError = (error: Error): void => {
    this.logSafely('应用更新组件报告错误', error)
  }

  private requireSupported(): void {
    if (this.supportsAutoUpdate()) return
    throw new AppException({ code: ErrorCodes.invalidConfig, msg: unsupportedMessage })
  }

  private logSafely(message: string, error: unknown): void {
    const errorName = error instanceof Error ? error.name : undefined
    this.logger.warn(message, {
      ...(errorName === undefined ? {} : { errorName })
    })
  }
}

function normalizeText(value: string | null | undefined): string | undefined {
  const text = value?.trim()
  return text === undefined || text === '' ? undefined : text
}

function normalizeReleaseNotes(value: UpdateInfo['releaseNotes']): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return normalizeText(value)
  const text = value
    .map((note) => note.note?.trim())
    .filter((note): note is string => note !== undefined && note !== '')
    .join('\n\n')
  return text === '' ? undefined : text
}
