import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { assertRelativePath, resolveContained } from '../containedPath'
import { digestBytes } from '../objects/gitContent'
import { asGitException } from '../gitErrors'
import { assertWorkRepository, readHead } from './repositoryGuard'
import type { ContentPresence, WorkBaseline, WorkPathState } from '../GitRepository'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

interface IndexedPath {
  readonly headOid: string | null
  readonly stageOid: string | null
}

/**
 * 只读读取正式仓库基线。不刷新索引，也不创建提交。
 * @returns HEAD、分支和各路径的提交、暂存区、工作区摘要。
 * @throws {AppException} 仓库、提交或路径无法读取。
 */
export async function readWorkBaseline(
  projectRoot: string,
  relativePaths: readonly string[]
): Promise<WorkBaseline> {
  const paths = relativePaths.map((relativePath) => assertRelativePath(relativePath))
  if (new Set(paths).size !== paths.length) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '基线路径重复' })
  }
  await assertWorkRepository(projectRoot)
  const head = await readHead(projectRoot)
  const indexed = await readIndexPaths(projectRoot)
  const states: WorkPathState[] = []
  for (const relativePath of paths) {
    const entry = indexed.get(relativePath)
    states.push({
      relativePath,
      head: await presenceOf(projectRoot, entry?.headOid ?? null),
      stage: await presenceOf(projectRoot, entry?.stageOid ?? null),
      worktree: await worktreePresence(projectRoot, relativePath)
    })
  }
  return { headCommitId: head.commitId, branch: head.branch, paths: states }
}

/**
 * 比较两次基线的提交、分支和已列出路径。未列出的路径不参与比较。
 * @param expected - 调用方持有的基线。
 */
export function baselinesMatch(expected: WorkBaseline, actual: WorkBaseline): boolean {
  if (expected.headCommitId !== actual.headCommitId || expected.branch !== actual.branch)
    return false
  if (expected.paths.length !== actual.paths.length) return false
  const actualPaths = new Map(actual.paths.map((path) => [path.relativePath, path]))
  return expected.paths.every((path) => {
    const fresh = actualPaths.get(path.relativePath)
    return (
      fresh !== undefined &&
      presenceEqual(path.head, fresh.head) &&
      presenceEqual(path.stage, fresh.stage) &&
      presenceEqual(path.worktree, fresh.worktree)
    )
  })
}

/**
 * 读取工作区文件。文件不存在时返回 null；符号链接越界时失败。
 * @returns 真实字节；文件不存在时为 null。
 * @throws {AppException} 路径越界或文件无法读取。
 */
export async function readWorktreeBytes(
  projectRoot: string,
  relativePath: string
): Promise<Uint8Array | null> {
  const absolute = await resolveContained(projectRoot, relativePath)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink()) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    if (!stats.isFile()) return null
    return new Uint8Array(await readFile(absolute))
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品文件无法读取')
  }
}

/**
 * 读取指定路径在暂存区中的 blob OID。没有索引项时为 null。
 * @returns 路径到暂存 OID 的映射。
 * @throws {AppException} 索引无法读取。
 */
export async function readStageOids(
  projectRoot: string,
  relativePaths: readonly string[]
): Promise<Map<string, string | null>> {
  const indexed = await readIndexPaths(projectRoot)
  return new Map(relativePaths.map((path) => [path, indexed.get(path)?.stageOid ?? null]))
}

async function readIndexPaths(projectRoot: string): Promise<Map<string, IndexedPath>> {
  try {
    const rows = (await git.walk({
      fs,
      dir: projectRoot,
      trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
      map: mapIndexEntry
    })) as Array<(IndexedPath & { filepath: string }) | null | undefined>
    const indexed = new Map<string, IndexedPath>()
    for (const row of rows) {
      if (!row) continue
      indexed.set(row.filepath.replaceAll('\\', '/'), {
        headOid: row.headOid,
        stageOid: row.stageOid
      })
    }
    return indexed
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品版本读取失败')
  }
}

async function mapIndexEntry(
  filepath: string,
  entries: Array<git.WalkerEntry | null>
): Promise<(IndexedPath & { filepath: string }) | undefined> {
  if (filepath === '.') return undefined
  const [head, stage] = entries
  const headType = head ? await head.type() : null
  const stageType = stage ? await stage.type() : null
  if (headType === 'tree' || stageType === 'tree' || (!head && !stage)) return undefined
  return {
    filepath,
    headOid: headType === 'blob' && head ? await head.oid() : null,
    stageOid: stageType === 'blob' && stage ? await stage.oid() : null
  }
}

async function presenceOf(projectRoot: string, oid: string | null): Promise<ContentPresence> {
  if (!oid) return { exists: false, digest: null }
  try {
    const { blob } = await git.readBlob({ fs, dir: projectRoot, oid })
    return { exists: true, digest: digestBytes(blob) }
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品对象无法读取')
  }
}

async function worktreePresence(
  projectRoot: string,
  relativePath: string
): Promise<ContentPresence> {
  const bytes = await readWorktreeBytes(projectRoot, relativePath)
  if (!bytes) return { exists: false, digest: null }
  return { exists: true, digest: digestBytes(bytes) }
}

function presenceEqual(left: ContentPresence, right: ContentPresence): boolean {
  return left.exists === right.exists && left.digest === right.digest
}

/**
 * @throws {AppException} 索引不存在或无法读取。
 */
export async function readIndexBytes(projectRoot: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(join(projectRoot, '.git', 'index')))
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品索引无法读取')
  }
}
