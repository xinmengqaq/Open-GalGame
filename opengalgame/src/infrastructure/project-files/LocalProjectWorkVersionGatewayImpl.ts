import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { VerifiedProjectReadLocation } from '@application/project-files/models/ProjectInputSourceReadFacts'
import type { PreparedProjectFileChange } from '@application/project-files/ports/ProjectFileOperationGateway'
import type {
  ProjectFileOperationSettlement,
  ProjectWorkVersionGateway
} from '@application/project-files/ports/ProjectWorkVersionGateway'
import type { VersionFileChange } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

const SOURCE_MODULE = 'project-files'

/**
 * 经版本应用服务发布工程文件。
 * 工程文件仍决定路径、目录版本和用户词汇；操作身份由版本服务生成。
 */
export class LocalProjectWorkVersionGatewayImpl implements ProjectWorkVersionGateway {
  constructor(
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly readCatalogVersion: (project: VerifiedProjectReadLocation) => Promise<string>
  ) {}

  /**
   * 准备版本身份后提交声明路径。
   * 请求里的 operationId 是工程文件协议留下的调用方标识，不当作版本身份。
   */
  async publish(request: {
    project: VerifiedProjectReadLocation
    operationId: string
    changes: readonly PreparedProjectFileChange[]
    watchedPaths?: readonly string[]
    expectedCatalogVersion: string
  }): Promise<void> {
    const changePaths = request.changes.map((change) => change.relativePath)
    const watchedPaths = (request.watchedPaths ?? []).filter((path) => !changePaths.includes(path))
    const targets = [{ kind: 'project-catalog', id: request.project.projectId }]
    const existing = await this.versioning.readCallerOperation({
      projectId: request.project.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: request.operationId
    })
    const prepared = existing
      ? await this.versioning.readPreparedOperation({
          projectId: request.project.projectId,
          operationId: existing.operationId
        })
      : await this.versioning.prepareOperation({
          projectId: request.project.projectId,
          sourceModule: SOURCE_MODULE,
          targets,
          changePaths,
          watchedPaths
        })
    await this.versioning.bindCallerOperation({
      projectId: request.project.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: request.operationId,
      operationId: prepared.operationId,
      targets,
      changePaths,
      watchedPaths
    })
    const changes = await inlineFileChanges(request.changes)
    try {
      await this.versioning.commitOperation(
        {
          projectId: request.project.projectId,
          operationId: prepared.operationId,
          baselineRef: prepared.baselineRef,
          input: { kind: 'files', changes },
          saveMode: 'manual',
          contentSource: 'operation',
          title: '更新工程文件',
          summary: '已保存声明的工程文件变更'
        },
        () => this.requirePublishPreconditions(request)
      )
    } catch (error) {
      if (
        error instanceof AppException &&
        (error.code === ProjectVersioningErrorCodes.insufficientEvidence ||
          error.code === ErrorCodes.internalError)
      ) {
        throw new AppException({
          code: ProjectFileErrorCodes.commitUnclear,
          msg: '提交结果不明确',
          cause: error
        })
      }
      throw error
    }
  }

  /** 按已绑定的版本身份核对。没有关联或证据矛盾时保持不能放开。 */
  async readOperation(
    project: VerifiedProjectReadLocation,
    operationId: string
  ): Promise<ProjectFileOperationSettlement> {
    const link = await this.versioning.readCallerOperation({
      projectId: project.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: operationId
    })
    if (!link || link.projectId !== project.projectId) return 'unsettled'
    try {
      const settlement = await this.versioning.readOperationSettlement({
        projectId: project.projectId,
        operationId: link.operationId
      })
      if (settlement.state === '待核对') return 'unsettled'
      if (settlement.state === '已提交' || settlement.state === '无变更') return 'committed'
      if (settlement.state === '未提交') return 'notCommitted'
      return 'unsettled'
    } catch (error) {
      if (error instanceof AppException) return 'unsettled'
      throw error
    }
  }

  /** 在版本服务的短提交边界内重读目录，并拒绝占用已有路径的新增。 */
  private async requirePublishPreconditions(request: {
    project: VerifiedProjectReadLocation
    changes: readonly PreparedProjectFileChange[]
    expectedCatalogVersion: string
  }): Promise<void> {
    const current = await this.readCatalogVersion(request.project)
    if (current !== request.expectedCatalogVersion) {
      throw new AppException({
        code: ProjectFileErrorCodes.catalogVersionChanged,
        msg: '目录已变化，请重新核对'
      })
    }
    await rejectOccupiedAdds(request.project.location.directory, request.changes)
  }
}

/**
 * 只把已经在内存或来源文件里的字节交给版本内容端口。
 * 没有字节时不能把路径伪装成已准备引用或候选引用。
 */
async function inlineFileChanges(
  changes: readonly PreparedProjectFileChange[]
): Promise<VersionFileChange[]> {
  const files: VersionFileChange[] = []
  for (const change of changes) {
    if (change.action === 'delete') {
      files.push({ relativePath: change.relativePath, action: 'delete' })
      continue
    }
    files.push({
      relativePath: change.relativePath,
      action: change.action,
      content: { kind: 'bytes', bytes: await inlineBytes(change) }
    })
  }
  return files
}

async function inlineBytes(change: PreparedProjectFileChange): Promise<Uint8Array> {
  if (change.bytes) return new Uint8Array(change.bytes)
  if (!change.sourceFile) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.invalidContentFingerprint,
      msg: '内容身份不能固定'
    })
  }
  try {
    return new Uint8Array(await readFile(change.sourceFile))
  } catch (error) {
    throw new AppException({
      code: ProjectFileErrorCodes.fileOperationFailed,
      msg: '工程文件无法读取',
      cause: error
    })
  }
}

async function rejectOccupiedAdds(
  projectRoot: string,
  changes: readonly PreparedProjectFileChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.action !== 'add') continue
    const target = insideProject(projectRoot, change.relativePath)
    try {
      await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof AppException) throw error
      throw new AppException({
        code: ProjectFileErrorCodes.fileOperationFailed,
        msg: '工程文件无法核对',
        cause: error
      })
    }
    throw new AppException({
      code: ProjectFileErrorCodes.fileNameConflict,
      msg: '该文件名已被占用'
    })
  }
}

function insideProject(projectRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '' || isAbsolute(relativePath)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提交路径不正确' })
  }
  const root = resolve(projectRoot)
  const target = resolve(root, relativePath)
  const compared = relative(root, target)
  if (
    compared === '' ||
    compared.startsWith('..') ||
    isAbsolute(compared) ||
    compared.split(/[/\\]/u).includes('..')
  ) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提交路径不正确' })
  }
  return target
}
