import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { DirectoryOpenGateway } from '@application/system-path/ports/DirectoryOpenGateway'
import { AppException } from '@common/errors/AppException'
import {
  SystemPathErrorCodes,
  systemPathErrorMessages,
  type SystemPathErrorCode
} from '@domain/system-path/errors/SystemPathErrorCodes'

/** 系统打开一个路径；成功返回空字符串，失败返回错误文本。 */
export type OpenPathWithSystem = (absolutePath: string) => Promise<string>

/**
 * 打开本机绝对目录。
 * 先校验路径是存在的绝对目录，再交给宿主；不拼接命令，也不接受额外参数。
 */
export class LocalDirectoryOpenGateway implements DirectoryOpenGateway {
  constructor(private readonly openPath: OpenPathWithSystem) {}

  async openDirectory(absolutePath: string): Promise<void> {
    if (!isAbsolute(absolutePath)) throw pathError(SystemPathErrorCodes.pathRejected)
    let metadata
    try {
      metadata = await stat(absolutePath)
    } catch (error) {
      throw new AppException({
        code: SystemPathErrorCodes.pathRejected,
        msg: systemPathErrorMessages[SystemPathErrorCodes.pathRejected],
        cause: error
      })
    }
    if (!metadata.isDirectory()) throw pathError(SystemPathErrorCodes.pathRejected)
    let failure: string
    try {
      failure = await this.openPath(absolutePath)
    } catch (error) {
      throw new AppException({
        code: SystemPathErrorCodes.openFailed,
        msg: systemPathErrorMessages[SystemPathErrorCodes.openFailed],
        cause: error
      })
    }
    if (failure !== '') throw pathError(SystemPathErrorCodes.openFailed)
  }
}

function pathError(code: SystemPathErrorCode): AppException {
  return new AppException({ code, msg: systemPathErrorMessages[code] })
}
