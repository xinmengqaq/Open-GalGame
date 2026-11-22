import type { CandidatePreviewSessionResolution } from '../models/CandidatePreviewSession'

export type ResolveCandidatePreviewSessionRequest = {
  readonly projectId: string
  readonly sceneId: string
  readonly previewSessionId: string
}

export interface CandidatePreviewSessionGateway {
  resolveCandidatePreviewSession(
    request: ResolveCandidatePreviewSessionRequest
  ): Promise<CandidatePreviewSessionResolution>
}
