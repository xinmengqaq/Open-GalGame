import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'

import { projectDocumentFailure } from './projectDocumentFailure'
import {
  isTemporaryDocumentName,
  mapStorageFailure,
  readJsonDocument,
  writeJsonDocument
} from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import type { ProjectLocation } from '@application/projects/models/ProjectLocation'
import type { ProjectOperation } from '@application/projects/models/ProjectOperation'
import type { ProjectStorageGateway } from '@application/projects/ports/ProjectStorageGateway'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { Project } from '@domain/projects/models/Project'
import type { WorkspaceInspection } from '@domain/projects/models/ProjectWorkspace'

/** 工程格式版本；存储形态变化时递增，旧版本按不支持拒绝，不当作损坏工程修复。 */
const FORMAT_VERSION = 2
const CONFIG_DIRECTORY_NAME = '.opengalgame'
const MANIFEST_FILE_NAME = 'manifest.json'
const PROJECT_INFO_FILE_NAME = 'project.json'
const ASSETS_DIRECTORY_NAME = 'assets'
const STAGING_DIRECTORY_PREFIX = '.opengalgame-staging-'
const MANIFEST_MAX_BYTES = 65536

const projectManifestDocumentSchema = z.strictObject({
  formatVersion: z.number().int(),
  projectId: z.string(),
  operationId: z.string()
})
const manifestVersionSchema = z.object({ formatVersion: z.number().int() })
const projectInfoDocumentSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  synopsis: z.string(),
  sceneId: z.string().optional(),
  canvasId: z.string().optional()
})

const manifestFailure = projectDocumentFailure(
  ProjectErrorCodes.packageCorrupted,
  '工程身份清单无法解析'
)
const projectInfoFailure = projectDocumentFailure(
  ProjectErrorCodes.storageFailed,
  '工程信息读写失败'
)

type ProjectManifestDocument = z.infer<typeof projectManifestDocumentSchema>
type ProjectInfoDocument = z.infer<typeof projectInfoDocumentSchema>

/**
 * 读取路径信息，不存在时返回 null，其余失败继续抛出。
 * @returns 路径信息；不存在时为 null。
 * @throws {Error} 除不存在外的读取失败。
 */
async function optionalStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 统一把文件操作的技术失败转换为项目异常。
 * @throws {AppException} 目录缺失或底层写入失败。
 */
async function fileOperation<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AppException({
        code: ProjectErrorCodes.selectedFileMissing,
        msg: '所选目录不存在或无法读取',
        cause: error
      })
    throw mapStorageFailure(
      error,
      projectDocumentFailure(ProjectErrorCodes.publishFailed, '工程文件操作失败，请重试原操作')
    )
  }
}

/**
 * @returns 解析后的根目录；位置不存在时为 null。
 * @throws {AppException} 位置是链接或不是目录。
 */
async function readProjectRoot(location: ProjectLocation): Promise<string | null> {
  const stat = await optionalStat(location.directory)
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AppException({
      code: ProjectErrorCodes.selectedFileMissing,
      msg: '请选择真实目录，不支持目录链接'
    })
  return realpath(location.directory)
}

/**
 * @param root - 工程根目录。
 * @throws {AppException} 标识不符、清单缺失或损坏、格式版本不支持。
 */
async function readManifest(root: string): Promise<ProjectManifestDocument> {
  const marker = join(root, CONFIG_DIRECTORY_NAME)
  const markerStat = await lstat(marker)
  if (!markerStat.isDirectory() || markerStat.isSymbolicLink())
    throw new AppException({
      code: ProjectErrorCodes.packageCorrupted,
      msg: '工作区标识必须是真实目录'
    })
  const path = join(marker, MANIFEST_FILE_NAME)
  const stat = await optionalStat(path)
  if (!stat)
    throw new AppException({
      code: ProjectErrorCodes.missingRequiredContent,
      msg: '已有工程缺少身份清单'
    })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX_BYTES)
    throw new AppException({ code: ProjectErrorCodes.packageCorrupted, msg: '工程身份清单损坏' })
  const value = await readJsonDocument(path, manifestFailure)
  if (value === null)
    throw new AppException({
      code: ProjectErrorCodes.missingRequiredContent,
      msg: '已有工程缺少身份清单'
    })
  const version = parseUnknownValue(
    manifestVersionSchema,
    value,
    ProjectErrorCodes.packageCorrupted,
    '工程身份清单字段不正确'
  )
  if (version.formatVersion !== FORMAT_VERSION)
    throw new AppException({
      code: ProjectErrorCodes.unsupportedFormatVersion,
      msg: '不支持此工程格式版本'
    })
  return parseUnknownValue(
    projectManifestDocumentSchema,
    value,
    ProjectErrorCodes.packageCorrupted,
    '工程身份清单字段不正确'
  )
}

/**
 * @returns 工程信息；文件不存在时为 null。
 * @throws {AppException} 读取失败或内容损坏。
 */
async function readProjectInfo(configDirectory: string): Promise<ProjectInfoDocument | null> {
  const value = await readJsonDocument(
    join(configDirectory, PROJECT_INFO_FILE_NAME),
    projectInfoFailure
  )
  if (value === null) return null
  return parseUnknownValue(
    projectInfoDocumentSchema,
    value,
    ProjectErrorCodes.packageCorrupted,
    '工程信息文件损坏'
  )
}

/**
 * @throws {AppException} 写入失败。
 */
async function writeProjectInfo(
  configDirectory: string,
  project: Project,
  current?: ProjectInfoDocument | null
): Promise<void> {
  await writeJsonDocument(
    join(configDirectory, PROJECT_INFO_FILE_NAME),
    {
      id: project.id,
      name: project.name,
      synopsis: project.synopsis,
      ...(current?.sceneId === undefined ? {} : { sceneId: current.sceneId }),
      ...(current?.canvasId === undefined ? {} : { canvasId: current.canvasId })
    },
    projectInfoFailure
  )
}

/**
 * @param root - 工程根目录。
 * @throws {AppException} 缺少工程信息或两处身份不一致。
 */
async function readExistingProject(
  root: string
): Promise<{ manifest: ProjectManifestDocument; project: ProjectInfoDocument }> {
  const manifest = await readManifest(root)
  const project = await readProjectInfo(join(root, CONFIG_DIRECTORY_NAME))
  if (!project)
    throw new AppException({
      code: ProjectErrorCodes.missingRequiredContent,
      msg: '已有工程缺少工程信息文件'
    })
  if (project.id !== manifest.projectId)
    throw new AppException({
      code: ProjectErrorCodes.packageCorrupted,
      msg: '工程清单与工程信息身份不一致'
    })
  return { manifest, project }
}

/**
 * 复用工程根下已有的素材目录，不清空、不覆盖其中已有文件。
 * @param root - 工程根目录。
 * @throws {AppException} 同名路径被文件或链接占用。
 */
async function createAssetsDirectory(root: string): Promise<void> {
  const path = join(root, ASSETS_DIRECTORY_NAME)
  const stat = await optionalStat(path)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new AppException({
      code: ProjectErrorCodes.destinationOccupied,
      msg: '工程根下的 assets 被同名文件或链接占用，请先处理'
    })
  await mkdir(path, { recursive: true })
}

export class LocalProjectStorageGatewayImpl implements ProjectStorageGateway {
  /** 只读识别标识与工程信息，不修复已有工程。 */
  inspect(location: ProjectLocation): Promise<WorkspaceInspection> {
    return fileOperation(async () => {
      const root = await readProjectRoot(location)
      if (!root)
        throw new AppException({
          code: ProjectErrorCodes.selectedFileMissing,
          msg: '所选目录不存在或无法读取'
        })
      if (!(await optionalStat(join(root, CONFIG_DIRECTORY_NAME))))
        return { kind: 'uninitialized', directoryName: basename(root) }
      const existing = await readExistingProject(root)
      return { kind: 'existing', project: existing.project }
    })
  }

  /** 在本目录暂存完成后发布，原目录其他文件保持原样。 */
  initialize(operation: ProjectOperation): Promise<void> {
    return fileOperation(async () => {
      const root = await readProjectRoot(operation.location)
      if (!root)
        throw new AppException({
          code: ProjectErrorCodes.selectedFileMissing,
          msg: '所选目录不存在或无法读取'
        })
      const marker = join(root, CONFIG_DIRECTORY_NAME)
      if (await optionalStat(marker))
        throw new AppException({
          code: ProjectErrorCodes.destinationOccupied,
          msg: '工作区标识已存在，不能覆盖'
        })
      await this.discard(operation)
      const staging = this.stagingPath(root, operation)
      await writeProjectInfo(staging, Project.restore(operation.project), {
        id: operation.project.id,
        name: operation.project.name,
        synopsis: operation.project.synopsis,
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
      await writeJsonDocument(
        join(staging, MANIFEST_FILE_NAME),
        {
          formatVersion: FORMAT_VERSION,
          projectId: operation.project.id,
          operationId: operation.operationId
        } satisfies ProjectManifestDocument,
        manifestFailure
      )
      await createAssetsDirectory(root)
      if (await optionalStat(marker))
        throw new AppException({
          code: ProjectErrorCodes.destinationOccupied,
          msg: '工作区标识已存在，不能覆盖'
        })
      await rename(staging, marker)
    })
  }

  /** 识别发布后崩溃窗口，只承认本操作的完整工程。 */
  isPublished(operation: ProjectOperation): Promise<boolean> {
    return fileOperation(async () => {
      const root = await readProjectRoot(operation.location)
      if (!root) return false
      if (!(await optionalStat(join(root, CONFIG_DIRECTORY_NAME)))) return false
      const existing = await readExistingProject(root)
      return (
        existing.manifest.operationId === operation.operationId &&
        existing.project.id === operation.project.id
      )
    })
  }

  /** 把合法项目写回已有工程文件。返回写入事实，不抛业务异常。 */
  saveProjectInfo(location: ProjectLocation, project: Project): Promise<'saved' | 'missing'> {
    return fileOperation(async () => {
      const root = await readProjectRoot(location)
      if (!root) return 'missing'
      const configDirectory = join(root, CONFIG_DIRECTORY_NAME)
      const current = await readProjectInfo(configDirectory)
      if (!current || current.id !== project.id) return 'missing'
      await writeProjectInfo(configDirectory, project, current)
      return 'saved'
    })
  }

  discard(operation: ProjectOperation): Promise<void> {
    return fileOperation(async () => {
      const root = await readProjectRoot(operation.location)
      if (!root) return
      const staging = this.stagingPath(root, operation)
      const stat = await optionalStat(staging)
      if (!stat) return
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        resolve(await realpath(staging)) !== resolve(staging)
      )
        throw new AppException({
          code: ProjectErrorCodes.stagingCleanupFailed,
          msg: '暂存目录不安全，已停止清理'
        })
      await this.verifyStagingOwnership(staging, operation)
      await rm(staging, { recursive: true })
    })
  }

  /**
   * 暂存只允许含本操作写过的文件，凭清单里的操作标识确认归属。
   * @param staging - 暂存目录路径。
   * @throws {AppException} 含未知内容或清单归属不符。
   */
  private async verifyStagingOwnership(
    staging: string,
    operation: ProjectOperation
  ): Promise<void> {
    const entries = await readdir(staging)
    const known = [MANIFEST_FILE_NAME, PROJECT_INFO_FILE_NAME]
    if (entries.some((name) => !known.includes(name) && !isTemporaryDocumentName(name)))
      throw new AppException({
        code: ProjectErrorCodes.stagingCleanupFailed,
        msg: '暂存目录含未知内容，已停止清理'
      })
    if (!entries.includes(MANIFEST_FILE_NAME)) return
    const value = await readJsonDocument(
      join(staging, MANIFEST_FILE_NAME),
      projectDocumentFailure(
        ProjectErrorCodes.stagingCleanupFailed,
        '暂存目录的清单无法读取，已停止清理'
      )
    )
    const manifest = parseUnknownValue(
      projectManifestDocumentSchema,
      value,
      ProjectErrorCodes.stagingCleanupFailed,
      '暂存目录的清单无法识别，已停止清理'
    )
    if (manifest.operationId !== operation.operationId)
      throw new AppException({
        code: ProjectErrorCodes.stagingCleanupFailed,
        msg: '暂存目录不属于本操作，已停止清理'
      })
  }

  /**
   * @param root - 工程根目录。
   * @returns 暂存目录路径。
   * @throws {AppException} 操作标识格式不正确。
   */
  private stagingPath(root: string, operation: ProjectOperation): string {
    if (!OPERATION_ID_PATTERN.test(operation.operationId))
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作标识格式不正确' })
    return join(root, `${STAGING_DIRECTORY_PREFIX}${operation.operationId}`)
  }
}
