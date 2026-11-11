import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationVersionFacts
} from '../models/SceneGenerationExecution'
import type { SceneGenerationRequest } from '@domain/scene-generation/models/SceneGenerationRequest'
import type { SceneValidationReport } from '@domain/scene-generation/models/SceneValidationReport'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationVersionConflict } from './SceneGenerationVersionConflict'

/** 将应用执行事实转换为不含技术细节的领域请求。 */
export function toDomainRequest(
  execution: SceneGenerationExecution,
  facts: SceneGenerationVersionFacts
): SceneGenerationRequest {
  return {
    scene: { projectId: execution.projectId, sceneId: execution.sceneId },
    assets: execution.inputSnapshot.assets.map((asset) => ({
      assetId: asset.assetId,
      category: asset.category,
      sourceId: asset.sourceId
    })),
    documents: execution.inputSnapshot.documents,
    prompts: execution.inputSnapshot.prompts,
    fieldBindings: execution.inputSnapshot.fieldBindings,
    relations: execution.inputSnapshot.relations,
    confirmedControls: execution.inputSnapshot.confirmedControls,
    maxCorrections: execution.policy.maxCorrections,
    correctionsUsed: execution.budget.correctionsUsed,
    ...facts
  }
}

export function requireAcceptableCandidate(
  execution: SceneGenerationExecution,
  facts: SceneGenerationVersionFacts,
  candidate?: SceneGenerationCandidate,
  domainService: SceneGenerationDomainService = new SceneGenerationDomainServiceImpl()
): SceneValidationReport {
  const request = toDomainRequest(execution, facts)
  const report = candidate
    ? domainService.validateArtifact(candidate.artifact, request)
    : { issues: [] }
  const judgment = domainService.evaluateResult(report, request)
  if (judgment.status !== 'acceptable') {
    if (
      judgment.report.issues.some((issue) =>
        ['scene-locked', 'lock-unknown', 'baseline-changed', 'baseline-unknown'].includes(
          issue.code
        )
      )
    )
      throw new SceneGenerationVersionConflict(
        judgment.report.issues[0]?.message ?? '作品版本不允许覆盖'
      )
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: judgment.report.issues[0]?.message ?? '候选不符合场景生成规则'
    })
  }
  return judgment.report
}
