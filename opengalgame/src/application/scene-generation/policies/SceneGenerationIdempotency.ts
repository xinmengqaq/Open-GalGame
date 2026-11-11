import type {
  ForkSceneGenerationDTO,
  GenerateSceneDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationReplyDTO,
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../dto/SceneGenerationDTO'
import { generationFingerprint as fingerprintOf } from '../services/impl/SceneGenerationApplicationRules'

/** 形成工程、场景和操作隔离键。 */
export function operationKey(scope: SceneGenerationScopeDTO): string {
  return JSON.stringify([scope.projectId, scope.sceneId, scope.operationId])
}

export function threadKey(scope: SceneGenerationThreadDTO): string {
  return JSON.stringify([scope.projectId, scope.sceneId, scope.threadId])
}

/** 按业务字段计算人工回复指纹。问题组按 questionId 排序，顺序不同但内容相同视为一致。 */
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

/** 按稳定业务字段计算生成、分叉或修复重跑请求指纹。 */
export function generationFingerprint(
  request: GenerateSceneDTO | ForkSceneGenerationDTO | RetrySceneGenerationRepairDTO
): string {
  return fingerprintOf(request)
}
