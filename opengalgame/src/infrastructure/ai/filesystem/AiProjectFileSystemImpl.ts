import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import * as fs from 'node:fs'
import * as git from 'isomorphic-git'

import { assertRelativePath, resolveContained } from '../../git/containedPath'
import { digestBytes } from '../../git/objects/gitContent'
import { asGitException } from '../../git/gitErrors'
import { writeVerifiedBytes } from '../../git/gitEffects'
import {
  applyTreeEdits,
  readCommitFile,
  readCommitFiles,
  resolveRefIfExists
} from '../../git/objects/gitTree'
import { assertOperationId } from '../../git/transaction/OperationRecord'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'

export interface CandidateWorkspace {
  readonly projectId: string
  readonly threadId: string
  readonly operationId: string
  readonly rootDirectory: string
  readonly revisionGitDir: string
}

export interface CreateCandidateWorkspaceRequest {
  readonly projectId: string
  readonly threadId: string
  readonly operationId: string
  readonly projectRoot: string
  readonly sourcePaths: readonly string[]
}

export interface RestoreCandidateRevisionRequest {
  readonly projectId: string
  readonly threadId: string
  readonly operationId: string
  readonly revisionId: string
}

export interface CandidateFileBytes {
  readonly bytes: Uint8Array
  readonly digest: string
  readonly size: number
}

export interface CandidateEffects {
  publishRevision(gitDir: string, revisionId: string): Promise<void>
}

const realCandidateEffects: CandidateEffects = {
  async publishRevision(gitDir, revisionId) {
    try {
      await git.writeRef({
        fs,
        gitdir: gitDir,
        ref: revisionRef(revisionId),
        value: revisionId,
        force: false
      })
    } catch (error) {
      throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选修订无法发布')
    }
  }
}

export class AiProjectFileSystemImpl {
  locateWorkspace(identity: {
    projectId: string
    threadId: string
    operationId: string
  }): CandidateWorkspace {
    return this.workspaceOf(identity.projectId, identity.threadId, identity.operationId)
  }
  constructor(
    private readonly userStateRoot: string,
    private readonly effects: CandidateEffects = realCandidateEffects
  ) {}

  async createWorkspace(request: CreateCandidateWorkspaceRequest): Promise<CandidateWorkspace> {
    const workspace = this.workspaceOf(request.projectId, request.threadId, request.operationId)
    if (!isAbsolute(request.projectRoot)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '作品目录不是绝对路径' })
    }
    try {
      await lstat(workspace.rootDirectory)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选工作区已存在'
      })
    } catch (error) {
      if (error instanceof AppException) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选工作区无法建立')
      }
    }
    await mkdir(workspace.rootDirectory, { recursive: true })
    try {
      for (const sourcePath of request.sourcePaths) {
        await copySource(
          request.projectRoot,
          assertRelativePath(sourcePath),
          workspace.rootDirectory
        )
      }
      await ensureRevisionRepository(workspace.revisionGitDir)
      return workspace
    } catch (error) {
      throwWithCleanup(error, await removeIfPresent(workspace.rootDirectory), '候选工作区无法建立')
    }
  }

  async readFile(workspace: CandidateWorkspace, relativePath: string): Promise<CandidateFileBytes> {
    const bytes = await readContainedFile(this.requireRoot(workspace), relativePath)
    return { bytes, digest: digestBytes(bytes), size: bytes.byteLength }
  }

  async readText(
    workspace: CandidateWorkspace,
    relativePath: string
  ): Promise<CandidateFileBytes & { text: string }> {
    const file = await this.readFile(workspace, relativePath)
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
      return { ...file, text }
    } catch (error) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '文件不是有效的 UTF-8 文本',
        cause: error
      })
    }
  }

  async writeFile(
    workspace: CandidateWorkspace,
    relativePath: string,
    bytes: Uint8Array
  ): Promise<void> {
    if (!(bytes instanceof Uint8Array)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选文件内容必须是字节' })
    }
    const absolute = await resolveContained(this.requireRoot(workspace), relativePath)
    await writeVerifiedBytes(absolute, bytes)
  }

  async listFiles(workspace: CandidateWorkspace, relativeDirectory = ''): Promise<string[]> {
    const root = this.requireRoot(workspace)
    const files: string[] = []
    await collectFiles(root, relativeDirectory, files)
    return files.sort()
  }

  async saveRevision(workspace: CandidateWorkspace): Promise<{ revisionId: string }> {
    const root = this.requireRoot(workspace)
    const gitDir = workspace.revisionGitDir
    await ensureRevisionRepository(gitDir)
    const paths = await this.listFiles(workspace)
    const edits: Array<{ relativePath: string; action: 'upsert'; bytes: Uint8Array }> = []
    for (const relativePath of paths) {
      edits.push({
        relativePath,
        action: 'upsert' as const,
        bytes: await readContainedFile(root, relativePath)
      })
    }
    const parent = await resolveRefIfExists(
      { gitdir: gitDir },
      `refs/opengalgame/workspaces/${workspace.operationId}`
    )
    const tree = (await applyTreeEdits({ gitdir: gitDir }, null, edits)).treeOid
    const author = revisionAuthor()
    let revisionId: string
    try {
      revisionId = await git.writeCommit({
        fs,
        gitdir: gitDir,
        commit: {
          message: `保存候选修订\n\nOperation-Id: ${workspace.operationId}\n`,
          tree,
          parent: parent ? [parent] : [],
          author,
          committer: author
        }
      })
    } catch (error) {
      throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选修订无法写入')
    }
    await this.effects.publishRevision(gitDir, revisionId)
    try {
      await git.writeRef({
        fs,
        gitdir: gitDir,
        ref: `refs/opengalgame/workspaces/${workspace.operationId}`,
        value: revisionId,
        force: true
      })
    } catch (error) {
      throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选修订无法发布')
    }
    return { revisionId }
  }

  /**
   * 读取本操作已发布修订的归属与父修订，不读取可变工作区。
   * 提交必须带当前 operationId 的所有权记录；引用缺失或对象损坏时失败。
   * @throws {AppException} 修订不存在、owner 不符或对象无法读取。
   */
  async readOwnedRevision(request: {
    projectId: string
    threadId: string
    operationId: string
    revisionId: string
  }): Promise<{ revisionId: string; parentRevisionIds: readonly string[] }> {
    if (!/^[0-9a-f]{40}$/u.test(request.revisionId)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    }
    const workspace = this.workspaceOf(request.projectId, request.threadId, request.operationId)
    const published = await resolveRefIfExists(
      { gitdir: workspace.revisionGitDir },
      revisionRef(request.revisionId)
    )
    if (published !== request.revisionId)
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    let commit
    try {
      commit = await git.readCommit({
        fs,
        gitdir: workspace.revisionGitDir,
        oid: request.revisionId
      })
    } catch (error) {
      throw asGitException(
        error,
        SceneGenerationErrorCodes.gitQueryFailed,
        '候选修订不存在或已损坏'
      )
    }
    const owner = commit.commit.message
      .split(/\r?\n/u)
      .find((line) => line.startsWith('Operation-Id:'))
      ?.slice('Operation-Id:'.length)
      .trim()
    if (owner !== request.operationId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选修订不属于当前操作'
      })
    return { revisionId: request.revisionId, parentRevisionIds: commit.commit.parent }
  }

  /**
   * 当前操作工作区引用指向的已发布修订；没有引用时返回 undefined。
   * 只读取引用，不把可变工作区文件当作修订。
   */
  async currentWorkspaceRevision(request: {
    projectId: string
    threadId: string
    operationId: string
  }): Promise<string | undefined> {
    const workspace = this.workspaceOf(request.projectId, request.threadId, request.operationId)
    const value = await resolveRefIfExists(
      { gitdir: workspace.revisionGitDir },
      `refs/opengalgame/workspaces/${request.operationId}`
    )
    return value !== null && /^[0-9a-f]{40}$/u.test(value) ? value : undefined
  }

  async readRevisionFile(request: {
    projectId: string
    threadId: string
    operationId: string
    revisionId: string
    relativePath: string
  }): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{40}$/u.test(request.revisionId)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    }
    const workspace = this.workspaceOf(request.projectId, request.threadId, request.operationId)
    const [published, owned] = await Promise.all([
      resolveRefIfExists({ gitdir: workspace.revisionGitDir }, revisionRef(request.revisionId)),
      resolveRefIfExists(
        { gitdir: workspace.revisionGitDir },
        `refs/opengalgame/workspaces/${request.operationId}`
      )
    ])
    if (published !== request.revisionId || owned !== request.revisionId) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    }
    try {
      return await readCommitFile(
        { gitdir: workspace.revisionGitDir },
        request.revisionId,
        request.relativePath
      )
    } catch (error) {
      if (error instanceof AppException) throw error
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏',
        cause: error
      })
    }
  }

  async restoreRevision(request: RestoreCandidateRevisionRequest): Promise<CandidateWorkspace> {
    const workspace = this.workspaceOf(request.projectId, request.threadId, request.operationId)
    if (!/^[0-9a-f]{40}$/u.test(request.revisionId)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    }
    await ensureRevisionRepository(workspace.revisionGitDir)
    const resolved = await resolveRefIfExists(
      { gitdir: workspace.revisionGitDir },
      revisionRef(request.revisionId)
    )
    if (resolved !== request.revisionId) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选修订不存在或已损坏'
      })
    }
    const files = await readCommitFiles({ gitdir: workspace.revisionGitDir }, request.revisionId)
    try {
      await lstat(workspace.rootDirectory)
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '候选工作区已存在' })
    } catch (error) {
      if (error instanceof AppException) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选修订无法恢复')
      }
    }
    const staging = `${workspace.rootDirectory}.partial`
    await rm(staging, { recursive: true, force: true })
    try {
      await mkdir(staging, { recursive: true })
      for (const file of files) {
        await writeVerifiedBytes(await resolveContained(staging, file.relativePath), file.bytes)
      }
      await mkdir(join(workspace.rootDirectory, '..'), { recursive: true })
      const { rename } = await import('node:fs/promises')
      await rename(staging, workspace.rootDirectory)
      await git.writeRef({
        fs,
        gitdir: workspace.revisionGitDir,
        ref: `refs/opengalgame/workspaces/${request.operationId}`,
        value: request.revisionId,
        force: true
      })
      return workspace
    } catch (error) {
      throwWithCleanup(
        error,
        [...(await removeIfPresent(staging)), ...(await removeIfPresent(workspace.rootDirectory))],
        '候选修订无法恢复'
      )
    }
  }

  async discardWorkspace(workspace: CandidateWorkspace): Promise<void> {
    const root = this.requireRoot(workspace)
    try {
      const stats = await lstat(root)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
      }
      const real = await realpath(root)
      if (resolve(real) !== resolve(root)) {
        throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
      }
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      if (error instanceof AppException) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选工作区无法清理')
    }
  }

  private workspaceOf(
    projectId: string,
    threadId: string,
    operationId: string
  ): CandidateWorkspace {
    assertIdentity(projectId, '项目标识')
    assertIdentity(threadId, '线程标识')
    assertOperationId(operationId)
    if (!isAbsolute(this.userStateRoot)) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '用户状态目录不是绝对路径' })
    }
    const revisionGitDir = join(
      this.userStateRoot,
      'ai',
      'projects',
      projectId,
      'threads',
      threadId,
      'revisions'
    )
    return {
      projectId,
      threadId,
      operationId,
      rootDirectory: join(
        this.userStateRoot,
        'ai',
        'projects',
        projectId,
        'threads',
        threadId,
        'workspaces',
        operationId
      ),
      revisionGitDir
    }
  }

  private requireRoot(workspace: CandidateWorkspace): string {
    const expected = this.workspaceOf(
      workspace.projectId,
      workspace.threadId,
      workspace.operationId
    )
    if (
      resolve(workspace.rootDirectory) !== resolve(expected.rootDirectory) ||
      resolve(workspace.revisionGitDir) !== resolve(expected.revisionGitDir)
    ) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    return expected.rootDirectory
  }
}

async function removeIfPresent(path: string): Promise<unknown[]> {
  try {
    await rm(path, { recursive: true, force: true })
    return []
  } catch (cleanupError) {
    return [cleanupError]
  }
}

function throwWithCleanup(
  error: unknown,
  cleanupErrors: readonly unknown[],
  fallbackMsg: string
): never {
  const original =
    error instanceof AppException
      ? error
      : asGitException(error, SceneGenerationErrorCodes.gitUnavailable, fallbackMsg)
  if (cleanupErrors.length === 0) throw original
  throw new AppException({
    code: original.code,
    msg: `${original.message}，清理未完成，工作区可能仍有残留`,
    cause: new AggregateError([error, ...cleanupErrors], '候选工作区清理失败')
  })
}

function revisionRef(revisionId: string): string {
  return `refs/opengalgame/revisions/${revisionId}`
}

function assertIdentity(value: string, label: string): void {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: `${label}格式不正确` })
  }
}

function revisionAuthor(): {
  name: string
  email: string
  timestamp: number
  timezoneOffset: number
} {
  return {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset()
  }
}

async function ensureRevisionRepository(gitDir: string): Promise<void> {
  try {
    const stats = await lstat(gitDir)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitUnavailable,
        msg: '候选修订库无法访问'
      })
    }
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw asGitException(error, SceneGenerationErrorCodes.gitUnavailable, '候选修订库无法访问')
    }
    try {
      await git.init({ fs, dir: gitDir, bare: true, defaultBranch: 'revisions' })
    } catch (initError) {
      throw asGitException(
        initError,
        SceneGenerationErrorCodes.gitUnavailable,
        '候选修订库无法建立'
      )
    }
  }
}

async function copySource(
  projectRoot: string,
  relativePath: string,
  workspaceRoot: string
): Promise<void> {
  const absolute = await resolveContained(projectRoot, relativePath)
  let stats
  try {
    stats = await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '授权文件不存在'
      })
    }
    throw asGitException(error, SceneGenerationErrorCodes.gitQueryFailed, '授权文件无法读取')
  }
  if (stats.isSymbolicLink()) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  }
  if (stats.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      await copySource(projectRoot, `${relativePath}/${entry.name}`, workspaceRoot)
    }
    return
  }
  if (!stats.isFile()) {
    throw new AppException({
      code: SceneGenerationErrorCodes.gitQueryFailed,
      msg: '授权路径不是可复制的文件'
    })
  }
  const bytes = new Uint8Array(await readFile(absolute))
  await writeVerifiedBytes(await resolveContained(workspaceRoot, relativePath), bytes)
}

async function readContainedFile(root: string, relativePath: string): Promise<Uint8Array> {
  const absolute = await resolveContained(root, relativePath)
  try {
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    return new Uint8Array(await readFile(absolute))
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '候选文件不存在'
      })
    }
    throw asGitException(error, SceneGenerationErrorCodes.gitQueryFailed, '候选文件无法读取')
  }
}

async function collectFiles(
  root: string,
  relativeDirectory: string,
  files: string[]
): Promise<void> {
  const absolute =
    relativeDirectory.length === 0
      ? await realpath(root)
      : await resolveContained(root, relativeDirectory)
  let stats
  try {
    stats = await lstat(absolute)
  } catch (error) {
    throw asGitException(error, SceneGenerationErrorCodes.gitQueryFailed, '候选目录无法读取')
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  }
  const entries = await readdir(absolute, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.toLowerCase() === '.git') {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`
    if (entry.isSymbolicLink()) {
      await resolveContained(root, relativePath)
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    if (entry.isDirectory()) {
      await collectFiles(root, relativePath, files)
      continue
    }
    if (entry.isFile()) files.push(assertRelativePath(relativePath))
  }
}
