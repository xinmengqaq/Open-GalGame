import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { readProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

/**
 * 按已登记工程解析作品目录。
 * 不接受调用方传入的工程根，也不在失败说明里带出路径。
 * @throws {AppException} 工程未登记、位置不可用或登记无法读取。
 */
export async function resolveProjectWorkRoot(
  userDirectory: string,
  projectId: string
): Promise<string> {
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    projectId.includes('\0') ||
    projectId.includes('/') ||
    projectId.includes('\\')
  ) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '工程身份不正确' })
  }
  const registrations = await readProjectRegistrations(userDirectory)
  const matches = registrations.filter((item) => item.id === projectId)
  const directory = matches.length === 1 ? matches[0]?.directory : undefined
  if (!directory || !isAbsolute(directory)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '工程不可用' })
  }
  try {
    const stats = await lstat(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '工程位置不可用' })
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitUnavailable,
      msg: '工程暂时无法访问',
      cause: error
    })
  }
  return directory
}
