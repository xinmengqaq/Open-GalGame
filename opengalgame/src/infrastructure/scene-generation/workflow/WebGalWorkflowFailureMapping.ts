import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { FailureClass } from '@application/scene-generation/vo/SceneGenerationFailureVO'
import {
  nextActionsOf,
  SceneGenerationRunFailed
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import type {
  SceneGenerationFailureFact,
  SceneGenerationFailureFactBuilder
} from '@application/scene-generation/models/SceneGenerationFailureFacts'
import { AppException } from '@common/errors/AppException'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'
import { failureCodeOf, type RunErrorClassification } from './runFailureRouting'

/**
 * 从原始错误生成持久化事实和公开错误。公开错误只带窄原因，
 * 分类、原因名和诊断编号由注入的诊断事实构建器保留。
 */
export function terminalFailureOf(
  source: unknown,
  classified: RunErrorClassification | undefined,
  execution: SceneGenerationExecution,
  buildFailure: SceneGenerationFailureFactBuilder
): {
  fact: SceneGenerationFailureFact
  publicError: SceneGenerationRunFailed
} {
  const diagnostic = source instanceof AppException ? source : normalizeAgentError(source)
  const candidate = execution.candidateSnapshotId
    ? {
        candidateSnapshotId: execution.candidateSnapshotId,
        previewAuthorization: 'readOnly' as const
      }
    : undefined
  const base = buildFailure(diagnostic, candidate)
  const failureClass: FailureClass =
    classified?.failureClass ??
    (source instanceof SceneGenerationRunFailed ? source.failureClass : 'internal')
  const reason = classified?.reason ?? base.reason
  const code = failureCodeOf(failureClass)
  const fact: SceneGenerationFailureFact = {
    ...base,
    code,
    failureClass,
    nextActions: nextActionsOf(failureClass),
    ...(reason ? { reason } : {})
  }
  const publicError =
    source instanceof SceneGenerationRunFailed
      ? source
      : new SceneGenerationRunFailed({
          failureClass,
          ...(classified?.reason ? { reason: classified.reason } : {}),
          message: base.message,
          code,
          cause: diagnostic
        })
  return { fact, publicError }
}
