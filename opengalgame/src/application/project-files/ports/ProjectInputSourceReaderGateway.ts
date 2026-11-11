import type {
  ProjectFolderDeletionReadFact,
  ProjectInputCatalogReadFact
} from '../models/ProjectInputCatalogReadFacts'
import type {
  ProjectInputSourceInspectionFact,
  ProjectInputSourcesReadFact,
  ProjectInputSourceSummary,
  VerifiedProjectReadLocation
} from '../models/ProjectInputSourceReadFacts'

export interface ProjectInputSourceReaderGateway {
  /**
   * 扫描来源摘要和可读取状态。
   * 不加载全部正文或媒体字节。
   * @returns 保留重复身份的来源摘要。
   * @throws {AppException} 整次扫描无法完成。
   */
  scanProjectInputSources(
    project: VerifiedProjectReadLocation
  ): Promise<readonly ProjectInputSourceSummary[]>

  /**
   * @returns 可解析来源、缺失或损坏事实，以及格式是否受支持。
   * @throws {AppException} 无法完成工程范围的来源检查。
   */
  inspectProjectInputSources(
    project: VerifiedProjectReadLocation
  ): Promise<ProjectInputSourceInspectionFact>

  /**
   * @param sourceIds - 未经修剪的来源身份。
   * @throws {AppException} 来源缺失、损坏、越界或读取期间发生变化。
   */
  readProjectInputSources(
    project: VerifiedProjectReadLocation,
    sourceIds: readonly string[]
  ): Promise<ProjectInputSourcesReadFact>

  /**
   * 在同一次窗口内读取目录、归属和来源摘要。
   * 目录文件不存在时来源都在根，且不创建文件。
   * @throws {AppException} 目录损坏或整次扫描失败。
   */
  readProjectInputCatalog(
    project: VerifiedProjectReadLocation
  ): Promise<ProjectInputCatalogReadFact>

  /**
   * 读取文件夹删除计划。不写入文件。
   * @throws {AppException} 文件夹不存在，或子树无法完整确定。
   */
  readFolderDeletionPlan(
    project: VerifiedProjectReadLocation,
    folderId: string
  ): Promise<ProjectFolderDeletionReadFact>
}
