import type { SceneGenerationDomainService } from '../SceneGenerationDomainService'
import type { SceneGenerationArtifact } from '../../models/SceneGenerationArtifact'
import type { SceneGenerationRequest } from '../../models/SceneGenerationRequest'
import type { SceneCandidateJudgment } from '../../models/SceneCandidateJudgment'
import type { SceneValidationReport } from '../../models/SceneValidationReport'
import { evaluateSceneGenerationResult } from '../evaluateSceneGenerationResult'
import { validateSceneArtifact } from '../validateSceneArtifact'
import {
  validateSceneGenerationReply,
  type SceneGenerationAnswerFact,
  type SceneGenerationReplyCheckpoint,
  type SceneGenerationReplyExecution,
  type SceneGenerationReplyRequest,
  type SceneGenerationSelectionFact
} from '../validateSceneGenerationReply'

/** 场景生成领域规则的无状态实现。 */
export class SceneGenerationDomainServiceImpl implements SceneGenerationDomainService {
  validateArtifact(
    artifact: SceneGenerationArtifact,
    request: SceneGenerationRequest
  ): SceneValidationReport {
    return validateSceneArtifact(artifact, request)
  }

  evaluateResult(
    report: SceneValidationReport,
    request: SceneGenerationRequest
  ): SceneCandidateJudgment {
    return evaluateSceneGenerationResult(report, request)
  }

  validateReply(
    execution: SceneGenerationReplyExecution,
    request: SceneGenerationReplyRequest,
    checkpoint?: SceneGenerationReplyCheckpoint
  ): SceneGenerationSelectionFact | readonly SceneGenerationAnswerFact[] | undefined {
    return validateSceneGenerationReply(execution, request, checkpoint)
  }
}
