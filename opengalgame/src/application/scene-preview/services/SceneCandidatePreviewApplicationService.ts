import type { ReadCandidatePreviewDTO } from '../dto/ReadCandidatePreviewDTO'
import type { CandidatePreviewVO } from '../vo/CandidatePreviewVO'

export interface SceneCandidatePreviewApplicationService {
  readCandidatePreview(request: ReadCandidatePreviewDTO): Promise<CandidatePreviewVO>
}
