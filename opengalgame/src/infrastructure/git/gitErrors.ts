import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

export function asGitException(error: unknown, code: number, msg: string): AppException {
  if (error instanceof AppException) return error
  return new AppException({ code, msg, cause: error })
}

export function isMissingCommit(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'NoCommitError') return true
  if (error.name !== 'NotFoundError') return false
  const what = (error as { data?: { what?: string } }).data?.what ?? ''
  return what === 'HEAD' || what === 'refs/HEAD' || what.startsWith('refs/heads/')
}

export function unavailable(error: unknown, msg: string): AppException {
  return asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, msg)
}
