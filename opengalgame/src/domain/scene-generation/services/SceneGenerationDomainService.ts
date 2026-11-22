import type { SceneGenerationArtifact } from '../models/SceneGenerationArtifact'
import type { SceneGenerationRequest } from '../models/SceneGenerationRequest'
import type { SceneCandidateJudgment } from '../models/SceneCandidateJudgment'
import type { SceneValidationReport } from '../models/SceneValidationReport'
import type {
  SceneGenerationAnswerFact,
  SceneGenerationReplyCheckpoint,
  SceneGenerationReplyExecution,
  SceneGenerationReplyRequest,
  SceneGenerationSelectionFact
} from './validateSceneGenerationReply'

export interface SceneGenerationDomainService {
  validateArtifact(
    artifact: SceneGenerationArtifact,
    request: SceneGenerationRequest
  ): SceneValidationReport
  evaluateResult(
    report: SceneValidationReport,
    request: SceneGenerationRequest
  ): SceneCandidateJudgment
  validateReply(
    execution: SceneGenerationReplyExecution,
    request: SceneGenerationReplyRequest,
    checkpoint?: SceneGenerationReplyCheckpoint
  ): SceneGenerationSelectionFact | readonly SceneGenerationAnswerFact[] | undefined
}
