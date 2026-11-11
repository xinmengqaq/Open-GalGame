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

/** 场景生成领域规则契约，应用层只依赖此抽象。 */
export interface SceneGenerationDomainService {
  validateArtifact(
    artifact: SceneGenerationArtifact,
    request: SceneGenerationRequest
  ): SceneValidationReport
  /** 判定候选结果。可修正问题不靠修正次数截断。 */
  evaluateResult(
    report: SceneValidationReport,
    request: SceneGenerationRequest
  ): SceneCandidateJudgment
  /**
   * 校验当前回复。单题返回选项事实，问题组按题目顺序返回整组事实。
   * @returns 非选择回复没有选择事实。
   */
  validateReply(
    execution: SceneGenerationReplyExecution,
    request: SceneGenerationReplyRequest,
    checkpoint?: SceneGenerationReplyCheckpoint
  ): SceneGenerationSelectionFact | readonly SceneGenerationAnswerFact[] | undefined
}
