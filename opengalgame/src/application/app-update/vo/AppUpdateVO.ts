export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'

export type UpdateFailureKind =
  'unsupported' | 'source-unavailable' | 'download-failed' | 'install-failed' | 'invalid-state'

export type ReleaseSummaryVO = {
  version: string
  releaseName?: string
  releaseNotes?: string
  releasedAt?: string
}

export type UpdateProgressVO = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type UpdateFailureVO = {
  kind: UpdateFailureKind
  message: string
}

export type UpdateStatusVO = {
  phase: UpdatePhase
  currentVersion: string
  supported: boolean
  release?: ReleaseSummaryVO
  progress?: UpdateProgressVO
  failure?: UpdateFailureVO
}

export type UpdateCheckVO = {
  phase: 'available' | 'idle'
  currentVersion: string
  release?: ReleaseSummaryVO
}
