export type CandidatePreviewSessionState = 'active' | 'expired'

export type CandidatePreviewSessionRecord = {
  readonly previewSessionId: string
  readonly projectId: string
  readonly sceneId: string
  readonly sceneName: string
  readonly candidateSnapshotId: string
  readonly projectRoot: string
  readonly entryFile: string
  readonly metadataFiles: readonly string[]
  readonly expiresAt: string
  readonly state: CandidatePreviewSessionState
}
