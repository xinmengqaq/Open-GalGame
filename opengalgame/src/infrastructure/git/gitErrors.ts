import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

/**
 * 把技术失败转成已有错误码，业务异常原样抛出。
 * @param error - 原始失败。
 * @param code - 技术失败使用的错误码。
 */
export function asGitException(error: unknown, code: number, msg: string): AppException {
  if (error instanceof AppException) return error
  return new AppException({ code, msg, cause: error })
}

/**
 * 判断作品仓库是否还没有可读取的提交。
 * @param error - Git 库抛出的失败。
 */
export function isMissingCommit(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'NoCommitError') return true
  if (error.name !== 'NotFoundError') return false
  const what = (error as { data?: { what?: string } }).data?.what ?? ''
  return what === 'HEAD' || what === 'refs/HEAD' || what.startsWith('refs/heads/')
}

/**
 * 作品仓库暂时无法完成技术动作时使用的失败说明。
 * @param error - 原始失败。
 */
export function unavailable(error: unknown, msg: string): AppException {
  return asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, msg)
}
