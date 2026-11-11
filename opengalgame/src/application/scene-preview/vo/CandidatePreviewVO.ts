import type { SceneContentBasisVO } from './ScenePreviewSessionVO'

export type CandidatePreviewIssueVO = {
  readonly message: string
  readonly assetName?: string
}

export type CandidatePreviewVO = {
  readonly projectId: string
  readonly sceneId: string
  readonly sceneName: string
  readonly readOnly: true
  readonly candidate: {
    readonly previewSessionId: string
    readonly candidateSnapshotId: string
    readonly expiresAt: string
  }
  readonly contentBasis: SceneContentBasisVO
  readonly issues: readonly CandidatePreviewIssueVO[]
}
