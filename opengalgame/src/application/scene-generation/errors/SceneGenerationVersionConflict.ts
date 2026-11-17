import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export class SceneGenerationVersionConflict extends AppException {
  /** 标明提交前版本冲突应保留候选，不根据错误文案分类。 */
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCodes.operationConflict, msg: message, cause })
  }
}
