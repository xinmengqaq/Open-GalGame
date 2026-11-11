import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { WebgalInfrastructureError } from '@infrastructure/webgal/WebgalInfrastructureError'

/** 在共享端口出口转换技术失败，完整保留原始原因。 */
export function sceneReadException(error: unknown): AppException {
  if (error instanceof AppException) return error
  if (error instanceof WebgalInfrastructureError) {
    const code =
      error.kind === 'invalid-path'
        ? ErrorCodes.forbidden
        : error.kind === 'inconsistent-read'
          ? ErrorCodes.operationConflict
          : ErrorCodes.internalError
    return new AppException({ code, msg: error.message, cause: error })
  }
  return new AppException({ code: ErrorCodes.internalError, msg: '场景读取失败', cause: error })
}
