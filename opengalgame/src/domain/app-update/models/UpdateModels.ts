export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'

export type UpdateFailureKind =
  'unsupported' | 'source-unavailable' | 'download-failed' | 'install-failed' | 'invalid-state'

export type ReleaseInfo = {
  version: string
  releaseName?: string
  releaseNotes?: string
  releasedAt?: string
}

export type DownloadProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}
