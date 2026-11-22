import type {
  VersionLimitedChange,
  VersionScopeBaseline
} from '@application/project-versioning/ports/VersionTransactionGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { assertRelativePath } from '@infrastructure/git/containedPath'
import type { ContentPresence, WorkBaseline, WorkPathState } from '@infrastructure/git/GitRepository'
import { digestBytes } from '@infrastructure/git/objects/gitContent'
import { readWorkBaseline } from '@infrastructure/git/repository/WorkBaseline'
import { readRetainedBlob } from './FileVersionContentGateway'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

export type CommitScopeObservation = {
  readonly work: WorkBaseline
  readonly subsequentPaths: readonly string[]
}

export async function observeCommitScope(
  root: string,
  scope: readonly string[],
  changes: readonly VersionLimitedChange[],
  scopeBaseline: VersionScopeBaseline | undefined
): Promise<CommitScopeObservation> {
  const work = await readWorkBaseline(root, scope)
  const subsequentPaths =
    scope.length === 0
      ? []
      : scopeBaseline
        ? await pathsDriftedFromScope(root, work.paths, scopeBaseline, changes)
        : await pathsDriftedFromDeclaration(root, work.paths, changes)
  return { work, subsequentPaths }
}

export function assertScopeBaselineInput(input: {
  readonly changes: readonly VersionLimitedChange[]
  readonly scopeBaseline?: VersionScopeBaseline
}): void {
  const scope = input.scopeBaseline
  if (scope === undefined) return
  if (!COMMIT_PATTERN.test(scope.revisionRef)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选生成时修订不正确' })
  }
  const changes = input.changes.map((change) => assertRelativePath(change.relativePath))
  if (scope.paths.length !== changes.length) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选写集基点与声明路径不一致' })
  }
  const seen = new Set<string>()
  for (const path of scope.paths) {
    const relativePath = assertRelativePath(path.relativePath)
    if (!changes.includes(relativePath) || seen.has(relativePath)) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '候选写集基点与声明路径不一致'
      })
    }
    seen.add(relativePath)
    for (const digest of [path.worktree, path.stage]) {
      if (digest !== null && !DIGEST_PATTERN.test(digest)) {
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选写集基点摘要不正确' })
      }
    }
  }
}

async function pathsDriftedFromDeclaration(
  root: string,
  paths: readonly WorkPathState[],
  changes: readonly VersionLimitedChange[]
): Promise<string[]> {
  const declared = declaredChanges(changes)
  const drifted: string[] = []
  for (const path of paths) {
    if (!presenceChanged(path.head, path.stage) && !presenceChanged(path.head, path.worktree)) {
      continue
    }
    const change = declared.get(path.relativePath)
    if (change && (await matchesDeclaredContent(root, path, change))) continue
    drifted.push(path.relativePath)
  }
  return drifted
}

async function pathsDriftedFromScope(
  root: string,
  paths: readonly WorkPathState[],
  scopeBaseline: VersionScopeBaseline,
  changes: readonly VersionLimitedChange[]
): Promise<string[]> {
  const expected = new Map(
    scopeBaseline.paths.map((path) => [path.relativePath, path] as const)
  )
  const declared = declaredChanges(changes)
  const drifted: string[] = []
  for (const path of paths) {
    const base = expected.get(path.relativePath)
    const change = declared.get(path.relativePath)
    if (!base) {
      if (!presenceChanged(path.head, path.stage) && !presenceChanged(path.head, path.worktree)) {
        continue
      }
      if (change && (await matchesDeclaredContent(root, path, change))) continue
      drifted.push(path.relativePath)
      continue
    }
    const baseWorktree = presenceOfDigest(base.worktree)
    const baseStage = presenceOfDigest(base.stage)
    if (presenceEqual(path.worktree, baseWorktree) && presenceEqual(path.stage, baseStage)) {
      continue
    }
    if (!change) {
      drifted.push(path.relativePath)
      continue
    }
    if (await matchesDeclaredContent(root, path, change)) continue
    if (presenceEqual(path.stage, baseStage) && (await matchesDeclaredWorktree(root, path, change))) {
      continue
    }
    drifted.push(path.relativePath)
  }
  return drifted
}

function declaredChanges(
  changes: readonly VersionLimitedChange[]
): Map<string, VersionLimitedChange> {
  const declared = new Map<string, VersionLimitedChange>()
  for (const change of changes) {
    declared.set(assertRelativePath(change.relativePath), change)
  }
  return declared
}

function presenceOfDigest(digest: string | null): ContentPresence {
  return digest === null ? { exists: false, digest: null } : { exists: true, digest }
}

function presenceEqual(left: ContentPresence, right: ContentPresence): boolean {
  return !presenceChanged(left, right)
}

function presenceChanged(left: ContentPresence, right: ContentPresence): boolean {
  return left.exists !== right.exists || left.digest !== right.digest
}

async function matchesDeclaredWorktree(
  root: string,
  path: WorkPathState,
  change: VersionLimitedChange
): Promise<boolean> {
  if (change.action === 'delete') return !path.worktree.exists
  if (!change.retentionRef) throw identityUnfixed()
  const bytes = await readRetainedBlob(root, change.retentionRef)
  return presenceEqual({ exists: true, digest: digestBytes(bytes) }, path.worktree)
}

async function matchesDeclaredContent(
  root: string,
  path: {
    readonly head: ContentPresence
    readonly stage: ContentPresence
    readonly worktree: ContentPresence
  },
  change: VersionLimitedChange
): Promise<boolean> {
  if (change.action === 'delete') {
    if (change.retentionRef !== null) throw identityUnfixed()
    const stageSafe = !presenceChanged(path.head, path.stage) || !path.stage.exists
    return !path.worktree.exists && stageSafe
  }
  if (!change.retentionRef) throw identityUnfixed()
  const bytes = await readRetainedBlob(root, change.retentionRef)
  const expected = { exists: true, digest: digestBytes(bytes) }
  if (presenceChanged(expected, path.worktree)) return false
  return !presenceChanged(path.head, path.stage) || !presenceChanged(expected, path.stage)
}

function identityUnfixed(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.invalidContentFingerprint,
    msg: '内容身份不能固定'
  })
}
