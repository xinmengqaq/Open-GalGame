import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 候选修订已保存、但读取候选正文或预览时中断。
 * 写入与完成回执已证明，不能当成失败清理工作区；按类型进入可继续的 reading 边界。
 */
export class SceneGenerationReadInterrupted extends AppException {
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCodes.operationConflict, msg: message, cause })
  }
}
