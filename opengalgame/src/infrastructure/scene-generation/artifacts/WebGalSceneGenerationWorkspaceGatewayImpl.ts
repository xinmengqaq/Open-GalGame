import { lstat, readFile, stat } from 'node:fs/promises'
import * as git from 'isomorphic-git'
import * as fs from 'node:fs'
import type { SceneGenerationWorkspaceGateway } from '@application/scene-generation/ports/SceneGenerationWorkspaceGateway'
import type {
  SceneGenerationExecution,
  SceneGenerationRepairSource,
  SceneGenerationWorkspace
} from '@application/scene-generation/models/SceneGenerationExecution'
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
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'

export class WebGalSceneGenerationWorkspaceGatewayImpl implements SceneGenerationWorkspaceGateway {
  /** 注入共用候选文件系统，不建立另一份仓库。 */
  constructor(private readonly files: AiProjectFileSystemImpl) {}

  /** 复制目标入口、授权素材及必要元信息，保持真实 WebGAL 相对路径。 */
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

  /** 从不可变修订恢复当前操作独立目录，不能把现有工作区当作历史。 */
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

  /** 读取来源线程修订并在本线程发布新修订。来源标识不能成为本工作区候选。 */
  async materializeRepairInput(
    execution: SceneGenerationExecution,
    source: SceneGenerationRepairSource
  ): Promise<SceneGenerationWorkspace & { candidateSnapshotId: string }> {
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
    const sourceWorkspace = this.files.locateWorkspace({
      projectId: execution.projectId,
      threadId: source.threadId,
      operationId: source.operationId
    })
    const published = await resolveRefIfExists(
      { gitdir: sourceWorkspace.revisionGitDir },
      `refs/opengalgame/revisions/${source.candidateSnapshotId}`
    )
    const owned = await resolveRefIfExists(
      { gitdir: sourceWorkspace.revisionGitDir },
      `refs/opengalgame/workspaces/${source.operationId}`
    )
    if (published !== source.candidateSnapshotId || owned !== source.candidateSnapshotId) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '来源候选不可读，不能开始修复重跑'
      })
    }
    const files = await readCommitFiles(
      { gitdir: sourceWorkspace.revisionGitDir },
      source.candidateSnapshotId
    )
    const created = await this.files.createWorkspace({
      ...execution,
      projectRoot: execution.source.projectRoot,
      sourcePaths: []
    })
    try {
      const target = this.files.locateWorkspace(execution)
      const copied = await copyRevisionObjects(
        sourceWorkspace.revisionGitDir,
        target.revisionGitDir,
        files
      )
      for (const file of files) {
        const bytes = copied.get(file.relativePath)
        if (!bytes) {
          throw new AppException({
            code: SceneGenerationErrorCodes.gitQueryFailed,
            msg: '来源候选不可读，不能开始修复重跑'
          })
        }
        await this.files.writeFile(target, file.relativePath, bytes)
      }
      const revision = await this.files.saveRevision(target)
      if (revision.revisionId === source.candidateSnapshotId) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '修复输入不能沿用来源候选标识'
        })
      }
      return {
        ...this.toWorkspace(execution, created),
        candidateSnapshotId: revision.revisionId
      }
    } catch (error) {
      await this.files.discardWorkspace(created)
      throw error
    }
  }

  /** 只清理当前操作可变目录，保留历史修订。 */
  async discardWorkspace(execution: SceneGenerationExecution): Promise<void> {
    await this.files.discardWorkspace(this.files.locateWorkspace(execution))
  }

  /** 分叉更换输入时，把本次新增授权素材写入已恢复工作区并保存修订。 */
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

  /** 映射既有候选授权，不暴露 Git 技术记录。 */
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

/**
 * 读取正式工程中的授权素材，拒绝符号链接和目录。
 * @throws {AppException} 文件缺失、不是普通文件或路径越界。
 */
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
