import type { StartSceneGenerationDTO } from '../../dto/SceneGenerationDTO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SCENE_GENERATION_REPLY_BODY_LIMIT, type SceneGenerationAnswerFact, type SceneGenerationSelectionFact } from '@domain/scene-generation/services/validateSceneGenerationReply'

export function isAnswerGroup(
  value: SceneGenerationSelectionFact | readonly SceneGenerationAnswerFact[] | undefined
): value is readonly SceneGenerationAnswerFact[] {
  return Array.isArray(value)
}

export function requireLaunchIdentity(request: StartSceneGenerationDTO): void {
  if (
    request.projectId.trim() === '' ||
    request.sceneId.trim() === '' ||
    request.canvasId.trim() === ''
  ) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '当前工程、场景或画布身份不能为空'
    })
  }
}

export function requireRepairInstruction(instruction: string): void {
  const text = instruction.trim()
  if (text === '') {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '修改正文不能为空' })
  }
  if ([...text].length > SCENE_GENERATION_REPLY_BODY_LIMIT) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '回复正文不能超过 2000 个字符' })
  }
}
