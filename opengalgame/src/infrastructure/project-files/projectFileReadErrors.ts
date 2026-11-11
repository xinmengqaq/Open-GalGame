import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { StableFileReadError } from '@infrastructure/storage/StableProjectFileReader'

/**
 * 把工程文件读取的技术失败转换成已定义的安全错误。
 * 不根据错误消息猜测原因。
 * @param error - 路径、文件系统或解析失败。
 */
export function projectFileReadException(error: unknown): AppException {
  if (error instanceof AppException) {
    if (error.code === ErrorCodes.forbidden) {
      return new AppException({
        code: ProjectFileErrorCodes.pathEscapesProject,
        msg: '来源位置超出工程范围',
        cause: error
      })
    }
    return error
  }
  if (error instanceof StableFileReadError) {
    if (error.kind === 'missing') {
      return new AppException({
        code: ProjectFileErrorCodes.sourceMissing,
        msg: '来源不存在',
        cause: error
      })
    }
    if (error.kind === 'changed') {
      return new AppException({
        code: ProjectFileErrorCodes.readChanged,
        msg: '工程文件在读取期间发生变化',
        cause: error
      })
    }
    if (error.kind === 'too-large') {
      return new AppException({
        code: ProjectFileErrorCodes.unsupportedFormat,
        msg: '媒体文件超过 64 MiB，无法预览',
        cause: error
      })
    }
    if (error.kind === 'invalid-text' || error.kind === 'not-file') {
      return new AppException({
        code: ProjectFileErrorCodes.contentDamaged,
        msg: '工程文件内容损坏',
        cause: error
      })
    }
    return new AppException({
      code: ProjectFileErrorCodes.readFailed,
      msg: '工程文件无法读取',
      cause: error
    })
  }
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') {
    return new AppException({
      code: ProjectFileErrorCodes.readFailed,
      msg: '工程文件无法读取',
      cause: error
    })
  }
  return new AppException({
    code: ProjectFileErrorCodes.readFailed,
    msg: '工程文件无法读取',
    cause: error
  })
}
