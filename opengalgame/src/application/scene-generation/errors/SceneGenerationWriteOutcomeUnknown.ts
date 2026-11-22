import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 候选文件写入回执不明。只按类型进入待核对，不按错误文案分类；
 * 与正式提交结果不明（commitUnknown）保持不同语义。
 */
export class SceneGenerationWriteOutcomeUnknown extends AppException {
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCodes.operationConflict, msg: message, cause })
  }
}
