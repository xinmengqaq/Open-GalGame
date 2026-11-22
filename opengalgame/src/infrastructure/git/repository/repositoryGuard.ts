import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { asGitException, isMissingCommit } from '../gitErrors'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

export async function assertWorkRepository(projectRoot: string): Promise<void> {
  if (!isAbsolute(projectRoot)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '作品目录不是绝对路径' })
  }
  const gitDirectory = join(projectRoot, '.git')
  try {
    const stats = await lstat(gitDirectory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitNotRepository,
        msg: '作品目录不是 Git 仓库'
      })
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitNotRepository,
        msg: '作品目录不是 Git 仓库'
      })
    }
    throw asGitException(error, ProjectVersioningErrorCodes.gitUnavailable, '作品仓库暂时无法访问')
  }
}

export async function readHead(
  projectRoot: string
): Promise<{ commitId: string; branch: string | null }> {
  try {
    const commitId = await git.resolveRef({ fs, dir: projectRoot, ref: 'HEAD' })
    const branch = await git.currentBranch({ fs, dir: projectRoot, fullname: false })
    return { commitId, branch: branch ?? null }
  } catch (error) {
    if (isMissingCommit(error)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitNoCommits,
        msg: '作品仓库还没有可读取的提交'
      })
    }
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品版本读取失败')
  }
}

export async function readBranchRef(projectRoot: string): Promise<string> {
  try {
    const branch = await git.currentBranch({ fs, dir: projectRoot, fullname: true })
    if (!branch) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.gitQueryFailed,
        msg: '作品仓库处于分离头指针，无法发布提交'
      })
    }
    return branch
  } catch (error) {
    throw asGitException(error, ProjectVersioningErrorCodes.gitQueryFailed, '作品分支无法读取')
  }
}
