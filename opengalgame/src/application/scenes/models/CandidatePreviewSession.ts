export type CandidatePreviewSession = {
  readonly previewSessionId: string
  readonly projectId: string
  readonly sceneId: string
  readonly sceneName: string
  readonly candidateSnapshotId: string
  readonly projectRoot: string
  readonly entryFile: string
  readonly metadataFiles: readonly string[]
  readonly expiresAt: string
}

export type CandidatePreviewSessionResolution =
  | {
      readonly status: 'resolved'
      readonly session: CandidatePreviewSession
    }
  | {
      readonly status: 'rejected'
      readonly reason: 'missing' | 'expired' | 'mismatch'
    }
