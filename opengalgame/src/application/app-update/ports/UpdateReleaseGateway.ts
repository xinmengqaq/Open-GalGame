import type { DownloadProgress, ReleaseInfo } from '@domain/app-update/models/UpdateModels'

export interface UpdateReleaseGateway {
  supportsAutoUpdate(): boolean

  currentVersion(): string

  checkForUpdate(): Promise<ReleaseInfo | null>

  downloadUpdate(onProgress: (progress: DownloadProgress) => void): Promise<void>

  installUpdate(): Promise<void>
}
