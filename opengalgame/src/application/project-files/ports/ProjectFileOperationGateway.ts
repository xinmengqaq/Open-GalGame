import type { VerifiedProjectReadLocation } from '../models/ProjectInputSourceReadFacts'
import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import type { ProjectFileAssetKind } from '@domain/project-files/models/ProjectInputSource'
import type { ProjectMediaVO } from '../vo/ProjectMediaVO'

export type ImportFileType = 'document' | ProjectFileAssetKind

/** 本次导入文件的识别结果。失败消息不包含本机路径。 */
export type InspectedImportFile =
  | {
      ok: true
      fileName: string
      fileType: ImportFileType
      importFormat?: 'markdown' | 'plainText'
    }
  | { ok: false; fileName: string; message: string }

/** 一次作品提交要发布的明确路径变更。大文件用 sourceFile 流式写入，不再附带整份字节。 */
export type PreparedProjectFileChange = {
  relativePath: string
  action: 'add' | 'modify' | 'delete'
  bytes?: Uint8Array
  sourceFile?: string
}

/** 已准备的目录相关变更。watchedPaths 只参与发布前核对，不写入提交。 */
export type PreparedCatalogMutation = {
  changes: readonly PreparedProjectFileChange[]
  watchedPaths: readonly string[]
}

export type CatalogWriteFact = {
  folders: readonly ProjectFolder[]
  placements: readonly { sourceId: string; parentFolderId: string }[]
}

export type TextCreateSpec = {
  sourceId: string
  fileName: string
  textKind: 'document'
  format: 'markdown' | 'plainText'
  body: string
}

/** 覆盖已有文档正文的规格。expectedVersion 来自上次读取结果的来源版本。 */
export type TextBodyUpdateSpec = {
  sourceId: string
  body: string
  expectedVersion: string
}

export type SourceCopySpec = {
  sourceId: string
  newSourceId: string
  newFileId: string
  fileName: string
}

/** 已定位的工程文件。绝对路径只给打开端口，不进入返回结果。 */
export type LocatedProjectFile = {
  sourceId: string
  fileName: string
  contentKind: 'text' | ProjectFileAssetKind
  textKind?: 'document'
  readable: boolean
  absolutePath: string
}

/** 工程文件的定位、占用事实和写入准备。不决定提交边界，也不打开系统程序。 */
export interface ProjectFileOperationGateway {
  /**
   * 读取工程外文件并识别实际类型。普通格式失败返回失败事实，不抛出。
   * @returns 文件名和类型，或安全失败消息。
   */
  inspectImportFile(
    project: VerifiedProjectReadLocation,
    localFilePath: string
  ): Promise<InspectedImportFile>

  /**
   * @returns 已占用名称。比较由领域规则完成。
   */
  listOccupiedFileNames(project: VerifiedProjectReadLocation): Promise<readonly string[]>

  /**
   * 准备导入的来源记录和内容变更，不写入正式工程。
   * @param fileName - 领域规则选定的文件名。
   */
  prepareImport(
    project: VerifiedProjectReadLocation,
    sourceId: string,
    fileName: string,
    localFilePath: string
  ): Promise<readonly PreparedProjectFileChange[]>

  /**
   * @throws {AppException} 来源记录不存在。
   */
  locateProjectFile(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<LocatedProjectFile>

  /**
   * 按来源身份读取工程内素材的完整字节。
   * 拒绝文本来源、越界、符号链接、未知格式和超过上限的文件。
   * @throws {AppException} 来源不是可预览媒体，或文件无法安全读取。
   */
  readProjectMedia(project: VerifiedProjectReadLocation, sourceId: string): Promise<ProjectMediaVO>

  /**
   * 准备重命名的文件移动和记录更新，不写入正式工程。
   * @param newFileName - 已通过领域规则的新文件名。
   */
  prepareRename(
    project: VerifiedProjectReadLocation,
    sourceId: string,
    newFileName: string
  ): Promise<readonly PreparedProjectFileChange[]>

  /**
   * 准备删除来源记录；内容文件仍在时一并删除。
   * @throws {AppException} 来源记录不存在。
   */
  prepareDelete(
    project: VerifiedProjectReadLocation,
    sourceId: string
  ): Promise<readonly PreparedProjectFileChange[]>

  /** 准备目录记录变更。空目录且文件不存在时不产生变更。 */
  prepareCatalogWrite(
    project: VerifiedProjectReadLocation,
    catalog: CatalogWriteFact
  ): Promise<PreparedCatalogMutation>

  /** 准备新建文本的正文和来源描述，不写入正式工程。 */
  prepareTextCreate(
    project: VerifiedProjectReadLocation,
    spec: TextCreateSpec
  ): Promise<readonly PreparedProjectFileChange[]>

  /**
   * 准备覆盖已导入文档的正文，不写入正式工程。
   * @throws {AppException} 来源不存在、不是文档、正文不可读或版本已变化。
   */
  prepareTextUpdate(
    project: VerifiedProjectReadLocation,
    spec: TextBodyUpdateSpec
  ): Promise<readonly PreparedProjectFileChange[]>

  prepareFileCopy(
    project: VerifiedProjectReadLocation,
    spec: SourceCopySpec
  ): Promise<PreparedCatalogMutation>

  /** 按应用层确定的来源集合准备子树副本。任一来源无法读取时整次失败。 */
  prepareSubtreeCopy(
    project: VerifiedProjectReadLocation,
    copies: readonly SourceCopySpec[]
  ): Promise<PreparedCatalogMutation>

  /** 准备删除已确认拥有的来源内容。共享或无法确定归属时失败。 */
  prepareOwnedDeletes(
    project: VerifiedProjectReadLocation,
    sourceIds: readonly string[]
  ): Promise<PreparedCatalogMutation>
}
