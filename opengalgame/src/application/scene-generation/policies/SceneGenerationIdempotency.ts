import type {
  ForkSceneGenerationDTO,
  GenerateSceneDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationReplyDTO,
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../dto/SceneGenerationDTO'
import { generationFingerprint as fingerprintOf } from '../services/impl/SceneGenerationApplicationRules'

export function operationKey(scope: SceneGenerationScopeDTO): string {
  return JSON.stringify([scope.projectId, scope.sceneId, scope.operationId])
}

export function threadKey(scope: SceneGenerationThreadDTO): string {
  return JSON.stringify([scope.projectId, scope.sceneId, scope.threadId])
}

export function replyFingerprint(reply: SceneGenerationReplyDTO): string {
  return JSON.stringify({
    kind: reply.kind,
    body: 'body' in reply ? reply.body : undefined,
    optionId: 'optionId' in reply ? reply.optionId : undefined,
    answers:
      reply.kind === 'answers'
        ? [...reply.answers]
            .map((answer) => ({
              questionId: answer.questionId,
              optionId: answer.optionId,
              body: answer.body
            }))
            .sort((left, right) =>
              left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0
            )
        : undefined
  })
}

export function generationFingerprint(
  request: GenerateSceneDTO | ForkSceneGenerationDTO | RetrySceneGenerationRepairDTO
): string {
  return fingerprintOf(request)
}
