import type {
  CopyProjectFileDTO,
  CopyProjectFolderDTO,
  CreateProjectFolderDTO,
  CreateProjectTextFileDTO,
  DeleteProjectFileDTO,
  DeleteProjectFolderDTO,
  ImportProjectFilesDTO,
  InspectProjectFilesDTO,
  ListProjectInputSourcesDTO,
  MoveProjectFileDTO,
  ProjectFileScopeDTO,
  ProjectFolderScopeDTO,
  ReadProjectFileOperationDTO,
  ReadProjectInputSourcesDTO,
  ReadProjectMediaDTO,
  RenameProjectFileDTO,
  RenameProjectFolderDTO,
  UpdateProjectTextFileBodyDTO
} from '../dto/ProjectFilesDTO'
import type { ProjectFileOperationSettlementVO } from '../vo/ProjectFileOperationVO'
import type { ProjectMediaVO } from '../vo/ProjectMediaVO'
import type { ProjectFilesInspectionVO } from '../vo/ProjectFilesInspectionVO'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '../vo/ProjectInputCatalogVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '../vo/ProjectInputSourceVO'

export interface ProjectFilesApplicationService {
  /**
   * 检查工程输入来源及画布编排文件的格式与关联。
   * 可识别的文件问题作为诊断返回，不修复文件，也不生成提交。
   * @throws {AppException} 工程身份不匹配或无法定位。
   */
  inspectProjectFiles(request: InspectProjectFilesDTO): Promise<ProjectFilesInspectionVO>

  /**
   * 扫描工程输入来源，返回来源摘要及可读取状态。
   * 不加载全部正文或媒体字节。单个来源异常表示为不可读取；整次扫描无法完成时失败，失败不是空目录。
   * @returns 只读来源摘要。
   * @throws {AppException} 工程无法定位，或整次扫描无法完成。
   */
  listProjectInputSources(request: ListProjectInputSourcesDTO): Promise<ProjectInputCatalogVO>

  /**
   * 按稳定来源身份，读取同一读取窗口内一致的来源内容。
   * 不推断来源在场景中的用途，不组装生成上下文，也不建立生成操作。
   * @param request - 工程身份和来源身份。不接受路径、卡片坐标或生成策略。
   * @returns 完整来源事实及本次读取版本。读取版本不是作品提交身份。
   * @throws {AppException} 来源缺失、来源身份重复、内容损坏、路径越界或读取期间发生变化。转场没有可用名称或名称为空时按内容损坏失败。
   */
  readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<ProjectInputSourcesSnapshotVO>

  /**
   * 按来源身份读取工程内素材字节。
   * 不接受路径，不返回路径，也不写入作品。
   * @throws {AppException} 工程未登记、来源不是素材、格式不受支持或文件超过上限。
   */
  readProjectMedia(request: ReadProjectMediaDTO): Promise<ProjectMediaVO>

  /**
   * 将选定的本机文件导入工程。
   * 每个文件独立提交。普通单文件失败继续处理后续文件。提交结果不明确时停止。
   * @returns 成功摘要和失败文件的安全消息。
   * @throws {AppException} 工程无法定位，导入列表为空，或提交结果不明确。
   */
  importProjectFiles(request: ImportProjectFilesDTO): Promise<ImportProjectFilesVO>

  /**
   * 使用系统默认程序打开工程文件。
   * 成功只表示系统接受了打开请求。不创建作品提交。
   * @throws {AppException} 文件缺失或系统无法打开。
   */
  openProjectFile(request: ProjectFileScopeDTO): Promise<void>

  /**
   * 重命名工程文件，保留来源身份。
   * 名称未变化时不产生提交。
   * @throws {AppException} 扩展名改变、名称被占用或提交失败。
   */
  renameProjectFile(request: RenameProjectFileDTO): Promise<ProjectInputSourceSummaryVO>

  /**
   * 删除工程文件及对应来源记录。
   * 不删除卡片、画布或工程外原文件。
   * @throws {AppException} 来源记录不存在，或提交失败。
   */
  deleteProjectFile(request: DeleteProjectFileDTO): Promise<void>

  /** 创建文档或提示词来源。空正文不创建文件。 */
  createProjectTextFile(request: CreateProjectTextFileDTO): Promise<ProjectInputSourceSummaryVO>

  /**
   * 覆盖已导入文档的正文，保留来源身份、文件名和目录。
   * 版本不一致时不写入，由调用方重新读取后重试。
   * @throws {AppException} 来源不存在、不是文档、正文不可读或版本已变化。
   */
  updateProjectTextFileBody(request: UpdateProjectTextFileBodyDTO): Promise<ProjectInputSourceVO>

  createProjectFolder(request: CreateProjectFolderDTO): Promise<ProjectFolderVO>

  copyProjectFile(request: CopyProjectFileDTO): Promise<ProjectInputSourceSummaryVO>

  /** 移动文件归属。目标与当前父目录相同时不提交。 */
  moveProjectFile(request: MoveProjectFileDTO): Promise<ProjectInputSourceSummaryVO>

  copyProjectFolder(request: CopyProjectFolderDTO): Promise<ProjectFolderVO>

  /** 重命名文件夹。名称未变化时不提交。 */
  renameProjectFolder(request: RenameProjectFolderDTO): Promise<ProjectFolderVO>

  readProjectFolderDeletionPlan(
    request: ProjectFolderScopeDTO
  ): Promise<ProjectFolderDeletionPlanVO>

  /**
   * 按操作标识核对提交是否已经落地。不写入。
   * @returns 已提交、未提交，或仍不能判定。
   * @throws {AppException} 工程无法定位，或仓库无法读取。
   */
  readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<ProjectFileOperationSettlementVO>

  deleteProjectFolder(request: DeleteProjectFolderDTO): Promise<void>
}
