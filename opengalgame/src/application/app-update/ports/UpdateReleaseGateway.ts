import type { DownloadProgress, ReleaseInfo } from '@domain/app-update/models/UpdateModels'

/**
 * 应用更新发布源与安装能力。
 * 发布源只由安装包内的发布配置决定，端口不接受运行时地址。
 */
export interface UpdateReleaseGateway {
  /** 当前运行形态是否具备应用内更新能力。 */
  supportsAutoUpdate(): boolean

  /** 当前运行版本。 */
  currentVersion(): string

  /**
   * 查询发布源。
   * @returns 发布源报告的新版本；没有可用更新时为 null。
   * @throws {AppException} 发布源不可用或返回内容无法识别。
   */
  checkForUpdate(): Promise<ReleaseInfo | null>

  /**
   * 下载已确认的更新。
   * @param onProgress - 下载过程中的进度回调。
   * @throws {AppException} 下载或校验失败。
   */
  downloadUpdate(onProgress: (progress: DownloadProgress) => void): Promise<void>

  /**
   * 退出应用并安装已下载的更新。
   * @throws {AppException} 安装无法启动。
   */
  installUpdate(): Promise<void>
}
