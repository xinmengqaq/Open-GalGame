import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export class SceneGenerationVersionConflict extends AppException {
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCodes.operationConflict, msg: message, cause })
  }
}
