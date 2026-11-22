import type { VersionScopeBaselineDTO } from '../../dto/ProjectVersioningDTO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

export function assertRepositoryPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)) {
      fail(ProjectVersioningErrorCodes.pathOutOfScope, '路径必须位于工程内')
    }
    if (
      path
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..' || part === '.git')
    ) {
      fail(ProjectVersioningErrorCodes.pathOutOfScope, '路径必须位于工程内')
    }
  }
}

export function requireCommitScope(
  scope: VersionScopeBaselineDTO | undefined,
  changePaths: readonly string[]
): void {
  if (scope === undefined) return
  if (!COMMIT_PATTERN.test(scope.revisionRef)) fail(ErrorCodes.invalidRequest, '候选生成时修订不正确')
  if (scope.paths.length === 0) fail(ErrorCodes.invalidRequest, '候选写集基点为空')
  const declared = new Set(changePaths)
  const seen = new Set<string>()
  for (const path of scope.paths) {
    requireText(path.relativePath, '候选写集基点路径不正确')
    assertRepositoryPaths([path.relativePath])
    if (seen.has(path.relativePath)) fail(ErrorCodes.invalidRequest, '候选写集基点路径重复')
    seen.add(path.relativePath)
    if (!declared.has(path.relativePath)) fail(ErrorCodes.invalidRequest, '候选写集基点超出声明范围')
    for (const digest of [path.worktree, path.stage]) {
      if (digest !== null && !DIGEST_PATTERN.test(digest)) {
        fail(ErrorCodes.invalidRequest, '候选写集基点摘要不正确')
      }
    }
  }
  if (seen.size !== declared.size) fail(ErrorCodes.invalidRequest, '候选写集基点未覆盖声明范围')
}

function requireText(value: string, message: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    fail(ErrorCodes.invalidRequest, message)
  }
}

function fail(code: number, msg: string): never {
  throw new AppException({ code, msg })
}
