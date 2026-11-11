import { isProjectListResult } from '../contracts/ProjectResponseSchema'
import type { DesktopBridge } from './DesktopBridge'
import type { ProjectClient } from './ProjectClient'
import {
  communicationFailureResult,
  invokeAjaxResult,
  listProjectsFailureResult
} from './communicationFailure'
import type {
  CreateProjectDTO,
  ImportProjectDTO,
  ListProjectsDTO,
  OpenProjectDTO,
  RenameProjectDTO,
  UnregisterProjectDTO
} from '@application/projects/dto/ProjectDTO'
import type { EnsureProjectWorkspaceDTO } from '@application/projects/dto/ProjectWorkspaceDTO'
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
import type { AjaxResult } from '@common/contracts/AjaxResult'

export class ProjectClientImpl implements ProjectClient {
  /**
   * @param bridge - 与主进程通信的固定桥接。
   */
  constructor(private readonly bridge: DesktopBridge) {}
  chooseSaveLocation(): Promise<AjaxResult<ProjectSaveLocationVO | null>> {
    return invokeAjaxResult(() => this.bridge.chooseSaveLocation())
  }
  clearSaveLocation(): Promise<AjaxResult<null>> {
    return invokeAjaxResult(() => this.bridge.clearSaveLocation())
  }
  createProject(
    request: CreateProjectDTO,
    listener?: (progress: ProjectProgressVO) => void
  ): Promise<AjaxResult<ProjectOperationVO>> {
    return this.execute(request.operationId, () => this.bridge.createProject(request), listener)
  }
  importProject(
    request: ImportProjectDTO,
    listener?: (progress: ProjectProgressVO) => void
  ): Promise<AjaxResult<ProjectOperationVO>> {
    return this.execute(request.operationId, () => this.bridge.importProject(request), listener)
  }
  async listProjects(request: ListProjectsDTO): Promise<AjaxResult<ProjectListPageVO>> {
    try {
      const result = await this.bridge.listProjects(request)
      return isProjectListResult(result) ? result : listProjectsFailureResult()
    } catch {
      return listProjectsFailureResult()
    }
  }

  async openProject(request: OpenProjectDTO): Promise<AjaxResult<ProjectSummaryVO>> {
    return invokeAjaxResult(() => this.bridge.openProject(request))
  }

  async renameProject(request: RenameProjectDTO): Promise<AjaxResult<ProjectSummaryVO>> {
    return invokeAjaxResult(() => this.bridge.renameProject(request))
  }

  async unregisterProject(request: UnregisterProjectDTO): Promise<AjaxResult<UnregisterProjectVO>> {
    return invokeAjaxResult(() => this.bridge.unregisterProject(request))
  }

  /** 核对已登记工程的默认场景和作品基线。 */
  ensureProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<AjaxResult<ProjectWorkspaceVO>> {
    return invokeAjaxResult(() => this.bridge.ensureProjectWorkspace(request))
  }

  /** 只读检查已登记工程的工作区，不补建。 */
  inspectProjectWorkspace(
    request: EnsureProjectWorkspaceDTO
  ): Promise<AjaxResult<ProjectWorkspaceInspectionVO>> {
    return invokeAjaxResult(() => this.bridge.inspectProjectWorkspace(request))
  }

  /**
   * @param operationId - 当前操作标识，用于只转发本操作的进度。
   * @returns 操作结果，或通信失败结果。
   */
  private async execute(
    operationId: string,
    action: () => Promise<AjaxResult<ProjectOperationVO>>,
    listener?: (progress: ProjectProgressVO) => void
  ): Promise<AjaxResult<ProjectOperationVO>> {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = this.bridge.onProjectProgress((event) => {
        if (event.operationId === operationId) listener?.(event)
      })
      return await invokeAjaxResult(action)
    } catch {
      return communicationFailureResult()
    } finally {
      unsubscribe?.()
    }
  }
}
