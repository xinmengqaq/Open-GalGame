import type {
  CheckForUpdateDTO,
  DownloadUpdateDTO,
  InstallUpdateDTO,
  ReadUpdateStatusDTO
} from '@application/app-update/dto/AppUpdateDTO'
import type { UpdateCheckVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type {
  ConnectionSettingsDTO,
  ListModelsDTO
} from '@application/connections/dto/ConnectionSettingsDTO'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '@application/connections/vo/ConnectionSettingsVO'
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
} from '@application/project-files/dto/ProjectFilesDTO'
import type { ProjectFileOperationSettlementVO } from '@application/project-files/vo/ProjectFileOperationVO'
import type { ProjectFilesInspectionVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type {
  AttachSceneCanvasRelationRecordDTO,
  BindSceneCanvasFieldCardPresetDTO,
  ConnectSceneCanvasCardsDTO,
  CopySceneCanvasCardDTO,
  CreateSceneCanvasFieldCardDTO,
  CreateSceneCanvasPromptCardDTO,
  CreateSceneCanvasSourceCardDTO,
  DeleteSceneCanvasCardDTO,
  DetachSceneCanvasRelationRecordDTO,
  DisconnectSceneCanvasCardsDTO,
  EditSceneCanvasCardDTO,
  EditSceneCanvasMediaRoleDTO,
  EditSceneCanvasPromptBodyDTO,
  EditSceneCanvasRelationNameDTO,
  ReadSceneCanvasArrangementDTO as ReadCanvasArrangementDTO,
  SaveSceneCanvasArrangementDTO
} from '@application/scene-canvas/dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type {
  CreateProjectDTO,
  ImportProjectDTO,
  ListProjectsDTO,
  OpenProjectDTO,
  RenameProjectDTO,
  UnregisterProjectDTO
} from '@application/projects/dto/ProjectDTO'
import type {
  ClearVersionHistoryDTO,
  ListVersionHistoryDTO,
  UndoVersionHistoryDTO
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type {
  CloseSceneGenerationCandidatePreviewDTO,
  ListSceneGenerationHistoryForSceneDTO,
  OpenSceneGenerationCandidatePreviewDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidatePreviewEventVO,
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type {
  ProjectListPageVO,
  ProjectProgressVO,
  ProjectOperationVO,
  ProjectSaveLocationVO,
  ProjectSummaryVO,
  UnregisterProjectVO
} from '@application/projects/vo/ProjectVO'
import type {
  ProjectWorkspaceInspectionVO,
  ProjectWorkspaceVO
} from '@application/projects/vo/ProjectWorkspaceVO'
import type { EnsureProjectWorkspaceDTO } from '@application/projects/dto/ProjectWorkspaceDTO'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type {
  PreviewDialogueDraftDTO,
  ReadDialogueSaveSettlementDTO,
  SaveDialogueChangesDTO
} from '@application/scene-preview/dto/DialogueSaveDTO'
import type {
  PreviewDialoguePlaybackDTO,
  PreviewSessionRef,
  PreviewSubscriptionRequest
} from '@application/scene-preview/dto/PreviewPlaybackDTO'
import type { ReadCandidatePreviewDTO } from '@application/scene-preview/dto/ReadCandidatePreviewDTO'
import type { ReadScenePreviewAvailabilityDTO } from '@application/scene-preview/dto/ScenePreviewAvailabilityDTO'
import type {
  OpenScenePreviewDTO,
  PreparePreviewStageDTO
} from '@application/scene-preview/dto/ScenePreviewSessionDTO'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type {
  DialogueSaveSettlementVO,
  SaveDialogueChangesVO
} from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewStageResultVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '@application/scene-preview/vo/ScenePreviewAvailabilityVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { ReadLatestPreviewSaveDTO } from '@application/scene-export/dto/ReadLatestPreviewSaveDTO'
import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { OpenDirectoryDTO } from '@application/system-path/dto/OpenDirectoryDTO'

export interface DesktopBridge {
  /**
   * @returns 选中目录或取消。
   */
  chooseSaveLocation(): Promise<AjaxResult<ProjectSaveLocationVO | null>>
  clearSaveLocation(): Promise<AjaxResult<null>>
  createProject(request: CreateProjectDTO): Promise<AjaxResult<ProjectOperationVO>>
  importProject(request: ImportProjectDTO): Promise<AjaxResult<ProjectOperationVO>>
  listProjects(request: ListProjectsDTO): Promise<AjaxResult<ProjectListPageVO>>
  openProject(request: OpenProjectDTO): Promise<AjaxResult<ProjectSummaryVO>>
  renameProject(request: RenameProjectDTO): Promise<AjaxResult<ProjectSummaryVO>>
  unregisterProject(request: UnregisterProjectDTO): Promise<AjaxResult<UnregisterProjectVO>>
  /** 核对已登记工程的默认场景和作品基线。 */
  ensureProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<AjaxResult<ProjectWorkspaceVO>>
  /** 只读检查已登记工程的工作区，不补建。 */
  inspectProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<AjaxResult<ProjectWorkspaceInspectionVO>>
  inspectProjectFiles(
    request: InspectProjectFilesDTO
  ): Promise<AjaxResult<ProjectFilesInspectionVO>>
  listProjectInputSources(
    request: ListProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputCatalogVO>>
  readProjectInputSources(
    request: ReadProjectInputSourcesDTO
  ): Promise<AjaxResult<ProjectInputSourcesSnapshotVO>>
  /** 按来源身份读取工程内媒体字节。 */
  readProjectMedia(request: ReadProjectMediaDTO): Promise<AjaxResult<ProjectMediaVO>>
  /**
   * @returns 已保存编排；没有已保存编排时 data 为 null。
   */
  readSceneCanvasArrangement(
    request: ReadCanvasArrangementDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO | null>>
  createSceneCanvasSourceCard(
    request: CreateSceneCanvasSourceCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  createSceneCanvasPromptCard(
    request: CreateSceneCanvasPromptCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  createSceneCanvasFieldCard(
    request: CreateSceneCanvasFieldCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editSceneCanvasCard(
    request: EditSceneCanvasCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editSceneCanvasPromptBody(
    request: EditSceneCanvasPromptBodyDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  bindSceneCanvasFieldCardPreset(
    request: BindSceneCanvasFieldCardPresetDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editSceneCanvasMediaRole(
    request: EditSceneCanvasMediaRoleDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  copySceneCanvasCard(
    request: CopySceneCanvasCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  deleteSceneCanvasCard(
    request: DeleteSceneCanvasCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  connectSceneCanvasCards(
    request: ConnectSceneCanvasCardsDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  disconnectSceneCanvasCards(
    request: DisconnectSceneCanvasCardsDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editSceneCanvasRelationName(
    request: EditSceneCanvasRelationNameDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  attachSceneCanvasRelationRecord(
    request: AttachSceneCanvasRelationRecordDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  detachSceneCanvasRelationRecord(
    request: DetachSceneCanvasRelationRecordDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  /** 保存场景编排。成功 data 为 null。 */
  saveSceneCanvasArrangement(request: SaveSceneCanvasArrangementDTO): Promise<AjaxResult<null>>
  /** 选择待导入文件。取消时 data 为 null。 */
  chooseProjectFiles(): Promise<AjaxResult<readonly string[] | null>>
  importProjectFiles(request: ImportProjectFilesDTO): Promise<AjaxResult<ImportProjectFilesVO>>
  /** 用系统默认程序打开工程文件。 */
  openProjectFile(request: ProjectFileScopeDTO): Promise<AjaxResult<null>>
  renameProjectFile(request: RenameProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>
  deleteProjectFile(request: DeleteProjectFileDTO): Promise<AjaxResult<null>>
  createProjectTextFile(
    request: CreateProjectTextFileDTO
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>>
  /** 覆盖已导入文档的正文。 */
  updateProjectTextFileBody(
    request: UpdateProjectTextFileBodyDTO
  ): Promise<AjaxResult<ProjectInputSourceVO>>
  createProjectFolder(request: CreateProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>>
  copyProjectFile(request: CopyProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>
  moveProjectFile(request: MoveProjectFileDTO): Promise<AjaxResult<ProjectInputSourceSummaryVO>>
  copyProjectFolder(request: CopyProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>>
  renameProjectFolder(request: RenameProjectFolderDTO): Promise<AjaxResult<ProjectFolderVO>>
  readProjectFolderDeletionPlan(
    request: ProjectFolderScopeDTO
  ): Promise<AjaxResult<ProjectFolderDeletionPlanVO>>
  deleteProjectFolder(request: DeleteProjectFolderDTO): Promise<AjaxResult<null>>
  readProjectFileOperation(
    request: ReadProjectFileOperationDTO
  ): Promise<AjaxResult<ProjectFileOperationSettlementVO>>
  pathForDroppedFile(file: File): Promise<AjaxResult<string>>
  /**
   * @returns 不含凭据的配置。
   */
  getSettingsSummary(): Promise<AjaxResult<ConnectionSettingsVO | null>>
  testConnection(request: ConnectionSettingsDTO): Promise<AjaxResult<ConnectionTestVO>>
  saveSettings(request: ConnectionSettingsDTO): Promise<AjaxResult<ConnectionSettingsVO>>
  /**
   * @param request - 协议、地址、密钥与扩展使用方式。
   */
  listModels(request: ListModelsDTO): Promise<AjaxResult<ModelListVO>>
  /** 读取工程级用户历史。 */
  listVersionHistory(request: ListVersionHistoryDTO): Promise<AjaxResult<VersionHistoryPageVO>>
  /** 撤销一条用户历史对应的操作。 */
  undoVersionHistoryEntry(request: UndoVersionHistoryDTO): Promise<AjaxResult<VersionHistoryUndoVO>>
  /** 清理单条或确认边界内的用户历史。 */
  clearVersionHistory(request: ClearVersionHistoryDTO): Promise<AjaxResult<VersionHistoryClearVO>>
  onProjectProgress(listener: (progress: ProjectProgressVO) => void): () => void
  startSceneGeneration(
    request: StartSceneGenerationDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /** 修复重跑只带来源身份、画布身份和确认正文。 */
  retrySceneGenerationRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  getSceneGenerationStatus(
    request: SceneGenerationScopeDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /** 最近一次生成的只读状态；运行中的操作可能还没有检查点，没有记录时 data 为 null。 */
  getLatestSceneGeneration(request: {
    projectId: string
    sceneId: string
  }): Promise<AjaxResult<SceneGenerationRenderStatusVO | null>>
  replySceneGeneration(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  pauseSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  resumeSceneGeneration(
    request: ResumeSceneGenerationDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  cancelSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  listSceneGenerationHistory(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<AjaxResult<readonly SceneGenerationHistorySummaryVO[]>>
  readSceneGenerationCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<AjaxResult<SceneGenerationHistorySummaryVO>>
  openSceneGenerationPreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewVO>>
  closeSceneGenerationPreview(
    request: CloseSceneGenerationCandidatePreviewDTO
  ): Promise<AjaxResult<null>>
  subscribeSceneGenerationProgress(
    request: SceneGenerationScopeDTO & { threadId: string; branchId: string }
  ): Promise<AjaxResult<null>>
  onSceneGenerationProgress(
    listener: (progress: SceneGenerationRenderProgressEventVO) => void
  ): () => void
  readScenePreviewAvailability(
    request: ReadScenePreviewAvailabilityDTO
  ): Promise<AjaxResult<ScenePreviewAvailabilityVO>>
  openScenePreview(request: OpenScenePreviewDTO): Promise<AjaxResult<ScenePreviewSessionVO>>
  preparePreviewStage(request: PreparePreviewStageDTO): Promise<AjaxResult<PreviewStageResultVO>>
  previewDialogueDraft(request: PreviewDialogueDraftDTO): Promise<AjaxResult<PreviewDraftResultVO>>
  saveDialogueChanges(request: SaveDialogueChangesDTO): Promise<AjaxResult<SaveDialogueChangesVO>>
  readDialogueSaveSettlement(
    request: ReadDialogueSaveSettlementDTO
  ): Promise<AjaxResult<DialogueSaveSettlementVO>>
  selectPreviewDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>>
  playPreviousDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>>
  playNextDialogue(request: PreviewDialoguePlaybackDTO): Promise<AjaxResult<PreviewCommandResultVO>>
  closeScenePreview(request: PreviewSessionRef): Promise<AjaxResult<null>>
  subscribeScenePreviewRuntime(request: PreviewSubscriptionRequest): Promise<AjaxResult<null>>
  onScenePreviewRuntime(listener: (event: unknown) => void): () => void
  readCandidatePreview(request: ReadCandidatePreviewDTO): Promise<AjaxResult<CandidatePreviewVO>>
  readCandidatePreviewEvent(
    request: ReadCandidatePreviewDTO
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewEventVO | null>>
  onCandidatePreviewReady(listener: (event: unknown) => void): () => void
  onCandidatePreviewStageFailed(listener: (event: unknown) => void): () => void
  onCandidatePreviewInvalidated(listener: (event: unknown) => void): () => void
  exportSavedScene(request: ExportSavedSceneDTO): Promise<AjaxResult<SceneExportResultVO>>
  readLatestPreviewSave(
    request: ReadLatestPreviewSaveDTO
  ): Promise<AjaxResult<PreviewSaveVersionVO | null>>
  checkForUpdate(request: CheckForUpdateDTO): Promise<AjaxResult<UpdateCheckVO>>
  downloadUpdate(request: DownloadUpdateDTO): Promise<AjaxResult<UpdateStatusVO>>
  installUpdate(request: InstallUpdateDTO): Promise<AjaxResult<null>>
  readUpdateStatus(request: ReadUpdateStatusDTO): Promise<AjaxResult<UpdateStatusVO>>
  onAppUpdateStatus(listener: (status: UpdateStatusVO) => void): () => void
  openDirectory(request: OpenDirectoryDTO): Promise<AjaxResult<null>>
}
