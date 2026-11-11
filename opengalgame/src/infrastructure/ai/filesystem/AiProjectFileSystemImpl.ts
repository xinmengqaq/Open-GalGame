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
  /**
   * 发布候选修订引用。对象已经写完后才调用。
   * @throws {AppException} 引用无法发布。
   */
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

/** 候选工作区与候选 Git 修订的技术实现。目录由调用方给出的用户状态根推导，不装配其他模块。 */
export class AiProjectFileSystemImpl {
  /** 返回按身份推导的受限候选位置，供恢复、读取和版本适配共用，不创建文件。 */
  locateWorkspace(identity: {
    projectId: string
    threadId: string
    operationId: string
  }): CandidateWorkspace {
    return this.workspaceOf(identity.projectId, identity.threadId, identity.operationId)
  }
  /**
   * @param effects - 候选修订发布边界。默认写入真实引用。
   */
  constructor(
    private readonly userStateRoot: string,
    private readonly effects: CandidateEffects = realCandidateEffects
  ) {}

  /**
   * @throws {AppException} 路径越界、源文件无法读取或工作区已存在。
   */
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

  /**
   * @throws {AppException} 路径越界或文件无法读取。
   */
  async readFile(workspace: CandidateWorkspace, relativePath: string): Promise<CandidateFileBytes> {
    const bytes = await readContainedFile(this.requireRoot(workspace), relativePath)
    return { bytes, digest: digestBytes(bytes), size: bytes.byteLength }
  }

  /**
   * 按严格 UTF-8 读取文本。非法字节直接失败，不用替换字符代替。
   * @throws {AppException} 路径越界、文件无法读取或编码无效。
   */
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

  /**
   * 把字节完整写入候选文件并回读核对。不发布修订。
   * @throws {AppException} 路径越界或写入失败。
   */
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

  /**
   * 列出候选目录中的普通文件，不跟随符号链接或联接。
   * @param relativeDirectory - 候选根内的目录；省略时从根列出。
   * @throws {AppException} 路径越界或目录无法读取。
   */
  async listFiles(workspace: CandidateWorkspace, relativeDirectory = ''): Promise<string[]> {
    const root = this.requireRoot(workspace)
    const files: string[] = []
    await collectFiles(root, relativeDirectory, files)
    return files.sort()
  }

  /**
   * 核对当前候选文件后，把它们写入候选 Git 提交并发布保留引用。
   * @throws {AppException} 文件或修订发布失败。发布前失败不会留下可恢复引用。
   */
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
   * 按工程、线程和来源操作读取已发布修订中的一个普通文件。
   * 不读取可变工作区，引用与对象不一致时失败。
   * @returns 当时保存的字节；修订里没有该路径时为 null。
   * @throws {AppException} 身份、引用或对象无法证明。
   */
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

  /**
   * 在新的工作目录从指定修订恢复当时的文件，并把本操作修订引用绑定到来源。缺失对象时失败，不用当前文件代替。
   * @throws {AppException} 修订不存在、对象缺失或恢复失败。
   */
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

  /**
   * 删除当前操作的候选工作目录。保留修订、其他工作区和正式工程。
   * @throws {AppException} 目录不是本操作的真实目录，或删除失败。
   */
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

/**
 * 删除失败时返回失败本身。成功时返回空列表。
 * @returns 删除失败；成功时为空。
 */
async function removeIfPresent(path: string): Promise<unknown[]> {
  try {
    await rm(path, { recursive: true, force: true })
    return []
  } catch (cleanupError) {
    return [cleanupError]
  }
}

/**
 * 清理未完成时保留原始失败和清理失败。清理成功时只抛出原始失败。
 * @param error - 创建或恢复的原始失败。
 * @param cleanupErrors - 已经发生的删除失败。
 * @param fallbackMsg - 原始失败不是业务异常时的中文说明。
 * @throws {AppException} 原始失败；清理也失败时说明工作区可能仍有残留。
 */
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
