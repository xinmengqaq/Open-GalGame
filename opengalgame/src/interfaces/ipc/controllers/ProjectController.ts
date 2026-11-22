import { z } from 'zod'

import { IpcExceptionHandler } from '../errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../requestHandler'
import { parseRequest, type IpcRequestAccess } from '../RequestSchema'
import {
  createProjectSchema,
  ensureProjectWorkspaceSchema,
  inspectProjectWorkspaceSchema,
  importProjectSchema,
  listProjectsSchema,
  openProjectSchema,
  renameProjectSchema,
  unregisterProjectSchema
} from '../schemas/HomeRequestSchema'
import type { ProjectApplicationService } from '@application/projects/services/ProjectApplicationService'
import type {
  ProjectListPageVO,
  ProjectOperationVO,
  ProjectProgressListener,
  ProjectSaveLocationVO,
  ProjectSummaryVO,
  UnregisterProjectVO
} from '@application/projects/vo/ProjectVO'
import type {
  ProjectWorkspaceInspectionVO,
  ProjectWorkspaceVO
} from '@application/projects/vo/ProjectWorkspaceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export class ProjectController {
  private readonly handle: IpcRequestHandler

  /**
   * @param exceptions - 统一失败出口。
   * @param onProjectOpened - 工程打开成功后的工程级恢复；失败不得回滚已打开事实，
   *   回调方需自行隔离并记录，避免把打开响应改成失败。
   */
  constructor(
    private readonly projects: ProjectApplicationService,
    private readonly exceptions: IpcExceptionHandler,
    private readonly onProjectOpened?: (projectId: string) => Promise<void>
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  chooseSaveLocation(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectSaveLocationVO | null>> {
    return this.exceptions.handle({ requestId: access.requestId }, async () => {
      parseRequest(z.undefined(), input, access)
      const location = await this.projects.chooseSaveLocation()
      return {
        code: ErrorCodes.success,
        msg: location ? '已选择保存位置' : '已取消选择',
        data: location
      }
    })
  }

  clearSaveLocation(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(z.undefined(), input, access, '操作成功', () => {
      this.projects.clearSaveLocation()
      return null
    })
  }

  createProject(
    input: unknown,
    access: IpcRequestAccess,
    progress?: ProjectProgressListener
  ): Promise<AjaxResult<ProjectOperationVO>> {
    const context = { requestId: access.requestId, operationId: undefined as string | undefined }
    return this.exceptions.handle(context, async () => {
      const request = parseRequest(createProjectSchema, input, access)
      context.operationId = request.operationId
      const result = await this.projects.createProject(request, progress)
      return {
        code: ErrorCodes.success,
        msg: result.status === 'cancelled' ? '已取消选择' : '项目创建成功',
        data: result
      }
    })
  }

  importProject(
    input: unknown,
    access: IpcRequestAccess,
    progress?: ProjectProgressListener
  ): Promise<AjaxResult<ProjectOperationVO>> {
    const context = { requestId: access.requestId, operationId: undefined as string | undefined }
    return this.exceptions.handle(context, async () => {
      const request = parseRequest(importProjectSchema, input, access)
      context.operationId = request.operationId
      const result = await this.projects.importProject(request, progress)
      return {
        code: ErrorCodes.success,
        msg: result.status === 'cancelled' ? '已取消选择' : '项目已导入',
        data: result
      }
    })
  }

  listProjects(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ProjectListPageVO>> {
    return this.handle(listProjectsSchema, input, access, '项目列表读取成功', (request) =>
      this.projects.listProjects(request)
    )
  }

  openProject(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ProjectSummaryVO>> {
    return this.handle(openProjectSchema, input, access, '项目已打开', async (request) => {
      const summary = await this.projects.openProject(request)
      // 正常打开工程的生命周期点：结算上次退出遗留的已受理取消。
      // 回调负责隔离清理失败；打开结果不能被后台收尾改成失败。
      await this.onProjectOpened?.(request.id)
      return summary
    })
  }

  renameProject(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ProjectSummaryVO>> {
    return this.handle(renameProjectSchema, input, access, '项目已重命名', (request) =>
      this.projects.renameProject(request)
    )
  }

  unregisterProject(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<UnregisterProjectVO>> {
    return this.handle(unregisterProjectSchema, input, access, '已从列表移出', (request) =>
      this.projects.unregisterProject(request)
    )
  }

  ensureProjectWorkspace(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectWorkspaceVO>> {
    return this.handle(ensureProjectWorkspaceSchema, input, access, '工程工作区已核对', (request) =>
      this.projects.ensureProjectWorkspace(request)
    )
  }

  inspectProjectWorkspace(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectWorkspaceInspectionVO>> {
    return this.handle(
      inspectProjectWorkspaceSchema,
      input,
      access,
      '工程工作区已检查',
      (request) => this.projects.inspectProjectWorkspace(request)
    )
  }
}
