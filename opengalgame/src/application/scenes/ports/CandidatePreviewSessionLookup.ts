import type { CandidatePreviewSessionRecord } from '../models/CandidatePreviewSessionRecord'

export interface CandidatePreviewSessionLookup {
  findCandidatePreviewSession(previewSessionId: string): CandidatePreviewSessionRecord | undefined
}
