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

export class LocalProjectWorkVersionGatewayImpl implements ProjectWorkVersionGateway {
  constructor(
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly readCatalogVersion: (project: VerifiedProjectReadLocation) => Promise<string>
  ) {}

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
    if (existing?.state === 'notCommitted' || existing?.state === 'notStarted') {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '操作已终止，不能重试'
      })
    }
    const historical = existing
      ? null
      : await this.versioning.readCallerIdentity(
          request.project.projectId,
          SOURCE_MODULE,
          request.operationId
        )
    if (
      historical?.state === 'notCommitted' ||
      historical?.state === 'notStarted'
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '操作已终止，不能重试'
      })
    }
    const prepared = existing
      ? await this.versioning.readPreparedOperation({
          projectId: request.project.projectId,
          operationId: existing.operationId
        })
      : historical
        ? await this.versioning.readPreparedOperation({
            projectId: request.project.projectId,
            operationId: historical.operationId
          })
        : await this.versioning.prepareOrClaimCallerOperation({
            projectId: request.project.projectId,
            sourceModule: SOURCE_MODULE,
            callerOperationId: request.operationId,
            targets,
            changePaths,
            watchedPaths
          })
    if (historical?.state !== 'committed' && (existing || historical)) {
      await this.versioning.bindCallerOperation({
        projectId: request.project.projectId,
        sourceModule: SOURCE_MODULE,
        callerOperationId: request.operationId,
        operationId: prepared.operationId,
        targets,
        changePaths,
        watchedPaths
      })
    }
    const changes = await inlineFileChanges(request.changes)
    try {
      await this.versioning.commitOperation(
        {
          projectId: request.project.projectId,
          operationId: prepared.operationId,
          callerOperationId: request.operationId,
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
      const conflict = proofConflictOf(error)
      if (conflict) throw conflict
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

  async readOperation(
    project: VerifiedProjectReadLocation,
    operationId: string
  ): Promise<ProjectFileOperationSettlement> {
    const link = await this.versioning.readCallerOperation({
      projectId: project.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: operationId
    })
    if (!link || link.projectId !== project.projectId) {
      const identity = await this.versioning.readCallerIdentity(
        project.projectId,
        SOURCE_MODULE,
        operationId
      )
      if (identity?.state === 'committed') return 'committed'
      if (identity?.state === 'notCommitted') return 'notCommitted'
      return 'unsettled'
    }
    if (link.state === 'notStarted') return 'notStarted'
    if (link.state === 'committed') return 'committed'
    if (link.state === 'notCommitted') return 'notCommitted'
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
      const conflict = proofConflictOf(error)
      if (conflict) throw conflict
      if (error instanceof AppException) return 'unsettled'
      throw error
    }
  }

  async hasOperationLink(
    project: VerifiedProjectReadLocation,
    operationId: string
  ): Promise<boolean> {
    const link = await this.versioning.readCallerOperation({
      projectId: project.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: operationId
    })
    return link?.projectId === project.projectId
  }

  resolveCallerOperations(
    project: VerifiedProjectReadLocation,
    operationIds: readonly string[]
  ): Promise<
    readonly {
      callerOperationId: string
      state: 'pending' | 'notStarted' | 'committed' | 'notCommitted'
    }[]
  > {
    return this.versioning.resolveCallerOperations(
      project.projectId,
      SOURCE_MODULE,
      operationIds
    )
  }

  recoverProject(project: VerifiedProjectReadLocation): Promise<void> {
    return this.versioning.recoverProject(project.projectId, SOURCE_MODULE)
  }

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

function proofConflictOf(error: unknown): AppException | null {
  if (!(error instanceof AppException)) return null
  const cause = 'cause' in error ? error.cause : undefined
  return cause instanceof AppException &&
    cause.code === ProjectVersioningErrorCodes.gitQueryFailed
    ? cause
    : null
}

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
