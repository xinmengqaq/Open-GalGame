/** 单状态更新生命周期。失败是独立终态，恢复检查会重新进入 checking。 */
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'

/** 可安全展示给用户的失败分类。 */
export type UpdateFailureKind =
  'unsupported' | 'source-unavailable' | 'download-failed' | 'install-failed' | 'invalid-state'

/** 发布源返回的新版本事实。发行说明只保留纯文本。 */
export type ReleaseInfo = {
  version: string
  releaseName?: string
  releaseNotes?: string
  releasedAt?: string
}

/** 一次下载的进度。total 不大于 0 表示总量未知。 */
export type DownloadProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}
