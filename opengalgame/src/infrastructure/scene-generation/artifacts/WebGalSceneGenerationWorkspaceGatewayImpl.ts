import { lstat, readFile, stat } from 'node:fs/promises'
import * as git from 'isomorphic-git'
import * as fs from 'node:fs'
import type { SceneGenerationWorkspaceGateway } from '@application/scene-generation/ports/SceneGenerationWorkspaceGateway'
import type {
  SceneGenerationExecution,
  SceneGenerationWorkspace
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationRepairSource } from '@application/scene-generation/vo/SceneGenerationVO'
import {
  AiProjectFileSystemImpl,
  type CandidateWorkspace
} from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  applyTreeEdits,
  readCommitFiles,
  resolveRefIfExists
} from '@infrastructure/git/objects/gitTree'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'

export class WebGalSceneGenerationWorkspaceGatewayImpl implements SceneGenerationWorkspaceGateway {
  constructor(private readonly files: AiProjectFileSystemImpl) {}

  async createWorkspace(execution: SceneGenerationExecution): Promise<SceneGenerationWorkspace> {
    const sourcePaths = [
      `${execution.source.sceneDirectory}/${execution.source.entryFile}`,
      ...execution.inputSnapshot.assets.map((asset) => asset.relativePath)
    ]
    for (const path of ['.opengalgame/scene-locks.json', 'game/config.txt']) {
      try {
        if ((await stat(await resolveContained(execution.source.projectRoot, path))).isFile())
          sourcePaths.push(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return this.toWorkspace(
      execution,
      await this.files.createWorkspace({
        ...execution,
        projectRoot: execution.source.projectRoot,
        sourcePaths: [...new Set(sourcePaths)]
      })
    )
  }

  async restoreWorkspace(
    execution: SceneGenerationExecution,
    candidateSnapshotId?: string
  ): ReturnType<SceneGenerationWorkspaceGateway['restoreWorkspace']> {
    if (candidateSnapshotId) {
      const workspace = this.files.locateWorkspace(execution)
      const revision = await resolveRefIfExists(
        { gitdir: workspace.revisionGitDir },
        `refs/opengalgame/revisions/${candidateSnapshotId}`
      )
      if (revision !== candidateSnapshotId)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '候选修订缺失，已保留当前工作区'
        })
      await readCommitFiles({ gitdir: workspace.revisionGitDir }, candidateSnapshotId)
    }
    await this.files.discardWorkspace(this.files.locateWorkspace(execution))
    if (!candidateSnapshotId) return this.createWorkspace(execution)
    const restored = await this.files.restoreRevision({
      ...execution,
      revisionId: candidateSnapshotId
    })
    const addedRevision = await this.includeForkAssets(execution)
    return {
      ...this.toWorkspace(execution, restored),
      ...(addedRevision ? { candidateSnapshotId: addedRevision } : {})
    }
  }

  /**
   * 只读取已有证据：本操作已保存的输入修订与可变目录必须逐字节等于来源草稿。
   * 任一证据缺失或读不出来都返回 undefined，把是否恢复交给写入恢复门。
   */
  async proveRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<(SceneGenerationWorkspace & { candidateSnapshotId: string }) | undefined> {
    try {
      requireRepairSource(execution, source)
      const target = this.files.locateWorkspace(execution)
      if (!(await workspaceRootExists(target.rootDirectory))) return undefined
      const sourceFiles = await readProvenSourceFiles(this.files, execution, source)
      const owned = await resolveRefIfExists(
        { gitdir: target.revisionGitDir },
        `refs/opengalgame/workspaces/${execution.operationId}`
      )
      const revisionId = execution.repairInputSnapshotId ?? owned ?? undefined
      if (revisionId === undefined || revisionId === source.candidateSnapshotId) return undefined
      await this.files.readOwnedRevision({ ...execution, revisionId })
      const revisionFiles = await readCommitFiles(
        { gitdir: target.revisionGitDir },
        revisionId
      )
      const workingFiles = await readWorkspaceFiles(this.files, target)
      if (!sameFiles(sourceFiles, revisionFiles) || !sameFiles(sourceFiles, workingFiles))
        return undefined
      return { ...this.toWorkspace(execution, target), candidateSnapshotId: revisionId }
    } catch {
      return undefined
    }
  }

  /**
   * 来源草稿已准备、首个候选写入前中断时，按不可变来源和本操作工作区证据复用：
   * 已发布且内容等于来源的输入修订直接复用；完整复制但未发布草稿只补一次修订。
   * 现场不完整或无法证明时不清理、不重建，交给恢复边界保留待核对。
   * @throws {SceneGenerationWriteOutcomeUnknown} 既有工作区与来源草稿不一致。
   */
  async materializeRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }> {
    requireRepairSource(execution, source)
    if (execution.repairInputSnapshotId !== undefined)
      return this.reusePersistedRepairInput(execution, source)
    const sourceFiles = await readProvenSourceFiles(this.files, execution, source)
    const target = this.files.locateWorkspace(execution)
    if (await workspaceRootExists(target.rootDirectory))
      return this.adoptExistingRepairWorkspace(execution, target, source, sourceFiles)
    const created = await this.files.createWorkspace({
      ...execution,
      projectRoot: execution.source.projectRoot,
      sourcePaths: []
    })
    try {
      const copied = await copyRevisionObjects(
        this.files.locateWorkspace({
          projectId: execution.projectId,
          threadId: source.threadId,
          operationId: source.operationId
        }).revisionGitDir,
        target.revisionGitDir,
        sourceFiles
      )
      for (const file of sourceFiles) {
        const bytes = copied.get(file.relativePath)
        if (!bytes) {
          throw new AppException({
            code: SceneGenerationErrorCodes.gitQueryFailed,
            msg: '来源候选不可读，不能开始修复重跑'
          })
        }
        await this.files.writeFile(target, file.relativePath, bytes)
      }
      return this.publishRepairInput(execution, target, source.candidateSnapshotId)
    } catch (error) {
      await this.files.discardWorkspace(created)
      throw error
    }
  }

  /** 已持久化的输入修订优先；工作区存在时只核对，不删除也不重建。 */
  private async reusePersistedRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }> {
    const revisionId = execution.repairInputSnapshotId!
    if (revisionId === source.candidateSnapshotId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '修复输入不能沿用来源候选标识'
      })
    await this.files.readOwnedRevision({ ...execution, revisionId })
    const target = this.files.locateWorkspace(execution)
    const revisionFiles = await readCommitFiles({ gitdir: target.revisionGitDir }, revisionId)
    if (await workspaceRootExists(target.rootDirectory)) {
      const workingFiles = await readWorkspaceFiles(this.files, target)
      if (!sameFiles(revisionFiles, workingFiles))
        throw new SceneGenerationWriteOutcomeUnknown(
          '修复输入工作区与已保存修订不一致，已保留现场待核对'
        )
    } else {
      await this.files.restoreRevision({ ...execution, revisionId })
    }
    return { ...this.toWorkspace(execution, target), candidateSnapshotId: revisionId }
  }

  /** 已有工作区只能按来源逐字节复用；证明不了的内容不改写、不清理。 */
  private async adoptExistingRepairWorkspace(
    execution: SceneGenerationExecution,
    target: CandidateWorkspace,
    source: SceneGenerationRepairSource,
    sourceFiles: readonly { relativePath: string; bytes: Uint8Array }[]
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }> {
    const owned = await resolveRefIfExists(
      { gitdir: target.revisionGitDir },
      `refs/opengalgame/workspaces/${execution.operationId}`
    )
    if (owned !== null) {
      if (owned === source.candidateSnapshotId)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '修复输入不能沿用来源候选标识'
        })
      await this.files.readOwnedRevision({ ...execution, revisionId: owned })
      const revisionFiles = await readCommitFiles({ gitdir: target.revisionGitDir }, owned)
      const workingFiles = await readWorkspaceFiles(this.files, target)
      if (!sameFiles(sourceFiles, revisionFiles) || !sameFiles(sourceFiles, workingFiles))
        throw new SceneGenerationWriteOutcomeUnknown(
          '修复输入工作区与来源草稿不一致，已保留现场待核对'
        )
      return { ...this.toWorkspace(execution, target), candidateSnapshotId: owned }
    }
    const workingFiles = await readWorkspaceFiles(this.files, target)
    if (!sameFiles(sourceFiles, workingFiles))
      throw new SceneGenerationWriteOutcomeUnknown(
        '修复输入工作区与来源草稿不一致，已保留现场待核对'
      )
    return this.publishRepairInput(execution, target, source.candidateSnapshotId)
  }

  /** 只在完整草稿已存在时补一次本操作修订，不新建目录。 */
  private async publishRepairInput(
    execution: SceneGenerationExecution,
    target: CandidateWorkspace,
    sourceRevisionId: string
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }> {
    const revision = await this.files.saveRevision(target)
    if (revision.revisionId === sourceRevisionId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '修复输入不能沿用来源候选标识'
      })
    return { ...this.toWorkspace(execution, target), candidateSnapshotId: revision.revisionId }
  }

  async discardWorkspace(execution: SceneGenerationExecution): Promise<void> {
    await this.files.discardWorkspace(this.files.locateWorkspace(execution))
  }

  private async includeForkAssets(
    execution: SceneGenerationExecution
  ): Promise<string | undefined> {
    if (!execution.forkRequest?.inputChanges) return undefined
    const workspace = this.files.locateWorkspace(execution)
    const present = new Set(await this.files.listFiles(workspace))
    const missing = execution.inputSnapshot.assets.filter(
      (asset) => !present.has(asset.relativePath)
    )
    if (missing.length === 0) return undefined
    for (const asset of missing)
      await this.files.writeFile(
        workspace,
        asset.relativePath,
        await readAuthorizedFile(execution.source.projectRoot, asset.relativePath)
      )
    return (await this.files.saveRevision(workspace)).revisionId
  }

  private toWorkspace(
    execution: SceneGenerationExecution,
    candidate: CandidateWorkspace
  ): SceneGenerationWorkspace {
    return {
      workspaceId: execution.operationId,
      rootDirectory: candidate.rootDirectory,
      sceneDirectory: execution.source.sceneDirectory
    }
  }
}

/** 修复来源必须是当前执行持久化的同一来源，且不能是本线程操作。 */
function requireRepairSource(
  execution: SceneGenerationExecution,
  source: SceneGenerationRepairSource
): void {
  if (
    execution.repairSource?.operationId !== source.operationId ||
    execution.repairSource.threadId !== source.threadId ||
    execution.repairSource.branchId !== source.branchId ||
    execution.repairSource.checkpointId !== source.checkpointId ||
    execution.repairSource.candidateSnapshotId !== source.candidateSnapshotId ||
    execution.projectId === '' ||
    source.threadId === execution.threadId
  ) {
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '修复来源身份不匹配，不能读取旧候选'
    })
  }
}

/**
 * 读取来源线程的不可变候选正文。引用缺失、发布关系不符或正文不可读都拒绝，
 * 不能从可变工作区猜来源草稿。
 * @throws {AppException} 来源身份、引用或正文不可读。
 */
async function readProvenSourceFiles(
  files: AiProjectFileSystemImpl,
  execution: SceneGenerationExecution,
  source: SceneGenerationRepairSource
): Promise<Array<{ relativePath: string; bytes: Uint8Array }>> {
  const sourceWorkspace = files.locateWorkspace({
    projectId: execution.projectId,
    threadId: source.threadId,
    operationId: source.operationId
  })
  const published = await resolveRefIfExists(
    { gitdir: sourceWorkspace.revisionGitDir },
    `refs/opengalgame/revisions/${source.candidateSnapshotId}`
  )
  if (published !== source.candidateSnapshotId) {
    throw new AppException({
      code: SceneGenerationErrorCodes.gitQueryFailed,
      msg: '来源候选不可读，不能开始修复重跑'
    })
  }
  // 只以不可变修订和提交归属证明来源；来源操作后来继续执行或清理工作区时，
  // 已物化的修复输入仍可按原修订恢复。
  await files.readOwnedRevision({
    projectId: execution.projectId,
    threadId: source.threadId,
    operationId: source.operationId,
    revisionId: source.candidateSnapshotId
  })
  return readCommitFiles(
    { gitdir: sourceWorkspace.revisionGitDir },
    source.candidateSnapshotId
  )
}

/** 工作区根只判断是否存在；符号链接和普通文件都不作为可复用现场。 */
async function workspaceRootExists(rootDirectory: string): Promise<boolean> {
  try {
    const stats = await lstat(rootDirectory)
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    return true
  } catch (error) {
    if (error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 读取当前候选工作区的全部普通文件；读取失败时不把部分文件当作完整草稿。 */
async function readWorkspaceFiles(
  files: AiProjectFileSystemImpl,
  workspace: CandidateWorkspace
): Promise<Array<{ relativePath: string; bytes: Uint8Array }>> {
  const paths = await files.listFiles(workspace)
  const contents: Array<{ relativePath: string; bytes: Uint8Array }> = []
  for (const relativePath of paths)
    contents.push({ relativePath, bytes: (await files.readFile(workspace, relativePath)).bytes })
  return contents
}

/** 文件集合与字节都必须完全一致；路径顺序不参与比较。 */
function sameFiles(
  left: readonly { relativePath: string; bytes: Uint8Array }[],
  right: readonly { relativePath: string; bytes: Uint8Array }[]
): boolean {
  if (left.length !== right.length) return false
  const byPath = new Map(right.map((file) => [file.relativePath, file.bytes]))
  for (const file of left) {
    const bytes = byPath.get(file.relativePath)
    if (!bytes || !Buffer.from(file.bytes).equals(Buffer.from(bytes))) return false
  }
  return true
}

async function readAuthorizedFile(projectRoot: string, relativePath: string): Promise<Uint8Array> {
  const absolute = await resolveContained(projectRoot, relativePath)
  let stats
  try {
    stats = await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '授权文件不存在'
      })
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
  return new Uint8Array(await readFile(absolute))
}

async function copyRevisionObjects(
  sourceGitDir: string,
  targetGitDir: string,
  files: readonly { relativePath: string; bytes: Uint8Array }[]
): Promise<Map<string, Uint8Array>> {
  const copied = new Map<string, Uint8Array>()
  for (const file of files) {
    const expected = await git.hashBlob({ object: file.bytes })
    const sourceObject = await git.readObject({ fs, gitdir: sourceGitDir, oid: expected.oid })
    if (sourceObject.type !== 'blob' || !Buffer.from(sourceObject.object).equals(file.bytes)) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '来源候选不可读，不能开始修复重跑'
      })
    }
    await git.writeBlob({ fs, gitdir: targetGitDir, blob: file.bytes })
    copied.set(file.relativePath, file.bytes)
  }
  await applyTreeEdits(
    { gitdir: targetGitDir },
    null,
    files.map((file) => ({
      relativePath: file.relativePath,
      action: 'upsert' as const,
      bytes: file.bytes
    }))
  )
  return copied
}
