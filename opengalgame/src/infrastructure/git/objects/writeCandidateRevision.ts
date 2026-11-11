import { lstat, mkdir } from 'node:fs/promises'
import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { asGitException } from '../gitErrors'
import { applyTreeEdits, type TreeEdit } from './gitTree'
import { writeLooseBlobFromFile } from './writeLooseBlob'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

export type CandidateEdit = TreeEdit & {
  /** 从该文件流式写入 blob，避免再保留一份完整字节。 */
  readonly sourceFile?: string
}

/**
 * 把明确路径的内容写入候选修订，供正式提交读取。
 * 不依赖生成线程或检查点。
 * @param edits - 要放进修订的新增或覆盖内容。删除不写入修订。
 * @throws {AppException} 修订无法建立或发布。
 */
export async function writeCandidateRevision(
  gitDir: string,
  edits: readonly CandidateEdit[]
): Promise<{ revisionId: string }> {
  await ensureRevisionRepository(gitDir)
  const prepared: TreeEdit[] = []
  for (const edit of edits) {
    if (!edit.sourceFile) {
      prepared.push(edit)
      continue
    }
    const stats = await lstat(edit.sourceFile)
    prepared.push({
      relativePath: edit.relativePath,
      action: 'upsert',
      blobOid: await writeLooseBlobFromFile(gitDir, edit.sourceFile, stats.size)
    })
  }
  const written = await applyTreeEdits({ gitdir: gitDir }, null, prepared)
  const author = {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset()
  }
  let revisionId: string
  try {
    revisionId = await git.writeCommit({
      fs,
      gitdir: gitDir,
      commit: {
        message: '准备作品文件变更\n',
        tree: written.treeOid,
        parent: [],
        author,
        committer: author
      }
    })
    await git.writeRef({
      fs,
      gitdir: gitDir,
      ref: `refs/opengalgame/revisions/${revisionId}`,
      value: revisionId,
      force: false
    })
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '候选修订无法写入')
  }
  return { revisionId }
}

async function ensureRevisionRepository(gitDir: string): Promise<void> {
  try {
    const stats = await lstat(gitDir)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitUnavailable,
        msg: '候选修订库无法访问'
      })
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '候选修订库无法访问')
    }
    await mkdir(gitDir, { recursive: true })
    try {
      await git.init({ fs, dir: gitDir, bare: true, defaultBranch: 'revisions' })
    } catch (initError) {
      throw asGitException(
        initError,
        ProjectVersioningErrorCodes.gitUnavailable,
        '候选修订库无法建立'
      )
    }
  }
}
