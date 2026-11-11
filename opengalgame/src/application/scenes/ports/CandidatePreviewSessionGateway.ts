import type { CandidatePreviewSessionResolution } from '../models/CandidatePreviewSession'

export type ResolveCandidatePreviewSessionRequest = {
  readonly projectId: string
  readonly sceneId: string
  readonly previewSessionId: string
}

export interface CandidatePreviewSessionGateway {
  /**
   * 核对固定候选会话仍存在、未过期且属于该项目和场景。
   * 预期拒绝返回 `rejected`；存储故障才抛出 `AppException`。
   */
  resolveCandidatePreviewSession(
    request: ResolveCandidatePreviewSessionRequest
  ): Promise<CandidatePreviewSessionResolution>
}
