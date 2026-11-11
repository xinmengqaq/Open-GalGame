import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { asGitException } from '../gitErrors'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

export interface GitLocation {
  readonly dir?: string
  readonly gitdir?: string
}

export interface TreeEdit {
  readonly relativePath: string
  readonly action: 'upsert' | 'delete'
  readonly bytes?: Uint8Array
  /** 已经写入对象库的 blob。提供时不再把字节读入内存。 */
  readonly blobOid?: string
}

interface LevelEdit {
  readonly parts: string[]
  readonly action: 'upsert' | 'delete'
  readonly bytes?: Uint8Array
  readonly blobOid?: string
}

const TREE_FAILURE = {
  code: ProjectVersioningErrorCodes.gitQueryFailed,
  msg: '作品提交树无法生成'
}

export interface TreeWrite {
  readonly treeOid: string
  readonly blobs: ReadonlyMap<string, string | null>
}

/**
 * 在基准树上应用路径编辑并写入新树，不读取或替换索引。
 * 每个文件只写一次 blob，调用方用返回的 OID 更新索引。
 * @param baseTreeOid - 基准树；空树时为 null。
 * @param edits - 相对路径上的新增、覆盖或删除。
 * @returns 新树对象标识，以及每个编辑路径的 blob OID；删除为 null。
 * @throws {AppException} 路径冲突或对象写入失败。
 */
export async function applyTreeEdits(
  location: GitLocation,
  baseTreeOid: string | null,
  edits: readonly TreeEdit[]
): Promise<TreeWrite> {
  try {
    return await editLevel(
      location,
      baseTreeOid,
      edits.map((edit) => ({
        parts: edit.relativePath.split('/'),
        action: edit.action,
        bytes: edit.bytes,
        blobOid: edit.blobOid
      }))
    )
  } catch (error) {
    throw asGitException(error, TREE_FAILURE.code, TREE_FAILURE.msg)
  }
}

/**
 * 读取一次提交里的普通文件。符号链接、子模块或缺失对象直接失败。
 * @throws {AppException} 提交或对象不存在，或包含不能恢复的条目。
 */
export async function readCommitFiles(
  location: GitLocation,
  commitOid: string
): Promise<Array<{ relativePath: string; bytes: Uint8Array }>> {
  try {
    const commit = await git.readCommit({ fs, ...location, oid: commitOid })
    const files: Array<{ relativePath: string; bytes: Uint8Array }> = []
    await collectTree(location, commit.commit.tree, '', files)
    return files
  } catch (error) {
    throw asGitException(
      error,
      ProjectVersioningErrorCodes.gitQueryFailed,
      '候选修订不存在或已损坏'
    )
  }
}

/**
 * 读取提交中单个文件的字节。文件不存在时返回 null。
 * @returns 文件字节；提交中没有该文件时为 null。
 * @throws {AppException} 对象缺失或无法读取。
 */
export async function readCommitFile(
  location: GitLocation,
  commitOid: string,
  relativePath: string
): Promise<Uint8Array | null> {
  try {
    const { blob } = await git.readBlob({ fs, ...location, oid: commitOid, filepath: relativePath })
    return blob
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return null
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品文件历史无法读取')
  }
}

/**
 * 读取提交的第一父提交。根提交没有父提交。
 * @returns 父提交标识；没有父提交时为 undefined。
 * @throws {AppException} 提交无法读取。
 */
export async function readCommitParent(
  location: GitLocation,
  commitOid: string
): Promise<string | undefined> {
  try {
    const commit = await git.readCommit({ fs, ...location, oid: commitOid })
    return commit.commit.parent[0]
  } catch (error) {
    throw asGitException(
      error,
      ProjectVersioningErrorCodes.gitQueryFailed,
      '候选修订不存在或已损坏'
    )
  }
}

/**
 * 解析引用。引用不存在时返回 null，其他失败继续抛出。
 * @returns 对象标识；引用不存在时为 null。
 * @throws {AppException} 引用无法读取。
 */
export async function resolveRefIfExists(
  location: GitLocation,
  ref: string
): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, ...location, ref })
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return null
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品引用无法读取')
  }
}

/**
 * 判断提交能否从当前 HEAD 沿父提交到达。
 * @throws {AppException} 历史无法读取。
 */
export async function isReachableFromHead(projectRoot: string, oid: string): Promise<boolean> {
  try {
    const head = await git.resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })
    if (head === oid) return true
    return await git.isDescendent({
      fs,
      dir: projectRoot,
      oid: head,
      ancestor: oid,
      depth: -1
    })
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品提交历史无法读取')
  }
}

async function editLevel(
  location: GitLocation,
  treeOid: string | null,
  edits: readonly LevelEdit[]
): Promise<TreeWrite> {
  const current = treeOid ? (await git.readTree({ fs, ...location, oid: treeOid })).tree : []
  const leaves = new Map<string, LevelEdit>()
  const groups = new Map<string, LevelEdit[]>()
  for (const edit of edits) {
    const [name, ...rest] = edit.parts
    if (!name) throw new AppException(TREE_FAILURE)
    if (rest.length === 0) leaves.set(name, edit)
    else {
      const children = groups.get(name) ?? []
      children.push({ ...edit, parts: rest })
      groups.set(name, children)
    }
  }
  const next: git.TreeEntry[] = current.filter(
    (entry) => !leaves.has(entry.path) && !groups.has(entry.path)
  )
  const blobs = new Map<string, string | null>()
  for (const [name, edit] of leaves) {
    const existing = current.find((entry) => entry.path === name)
    if (edit.action === 'delete') {
      if (!existing || existing.type !== 'blob') throw new AppException(TREE_FAILURE)
      blobs.set(name, null)
      continue
    }
    if (existing && existing.type !== 'blob') throw new AppException(TREE_FAILURE)
    if (edit.blobOid) {
      blobs.set(name, edit.blobOid)
      next.push({ mode: '100644', path: name, oid: edit.blobOid, type: 'blob' })
      continue
    }
    if (!edit.bytes) throw new AppException(TREE_FAILURE)
    const oid = await git.writeBlob({ fs, ...location, blob: edit.bytes })
    blobs.set(name, oid)
    next.push({ mode: '100644', path: name, oid, type: 'blob' })
  }
  for (const [name, children] of groups) {
    if (leaves.has(name)) throw new AppException(TREE_FAILURE)
    const existing = current.find((entry) => entry.path === name)
    if (existing && existing.type !== 'tree') throw new AppException(TREE_FAILURE)
    const child = await editLevel(location, existing?.oid ?? null, children)
    for (const [path, oid] of child.blobs) blobs.set(`${name}/${path}`, oid)
    const childTree = await git.readTree({ fs, ...location, oid: child.treeOid })
    if (childTree.tree.length === 0) continue
    next.push({ mode: '040000', path: name, oid: child.treeOid, type: 'tree' })
  }
  return { treeOid: await git.writeTree({ fs, ...location, tree: next }), blobs }
}

async function collectTree(
  location: GitLocation,
  treeOid: string,
  prefix: string,
  files: Array<{ relativePath: string; bytes: Uint8Array }>
): Promise<void> {
  const { tree } = await git.readTree({ fs, ...location, oid: treeOid })
  for (const entry of tree) {
    const relativePath = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`
    if (entry.type === 'tree') {
      await collectTree(location, entry.oid, relativePath, files)
      continue
    }
    if (entry.type !== 'blob' || entry.mode !== '100644') {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '候选修订包含无法恢复的文件'
      })
    }
    const { blob } = await git.readBlob({ fs, ...location, oid: entry.oid })
    files.push({ relativePath, bytes: blob })
  }
}
