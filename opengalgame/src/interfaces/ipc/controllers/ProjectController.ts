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
   */
  constructor(
    private readonly projects: ProjectApplicationService,
    private readonly exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  /**
   * 为新建选择保存位置。成功提示随取消与否而变，不套用统一入口。
   * @param input - 无参数请求。
   * @returns 选中目录或取消。
   */
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

  /**
   * @param input - 无参数请求。
   */
  clearSaveLocation(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(z.undefined(), input, access, '操作成功', () => {
      this.projects.clearSaveLocation()
      return null
    })
  }

  /** 创建请求入口。需在解析后补日志上下文，且成功提示随取消与否而变。 */
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

  /** 导入请求入口。需在解析后补日志上下文，且成功提示随取消与否而变。 */
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
    return this.handle(openProjectSchema, input, access, '项目已打开', (request) =>
      this.projects.openProject(request)
    )
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

  /** 核对已登记工程的默认场景和作品基线。 */
  ensureProjectWorkspace(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectWorkspaceVO>> {
    return this.handle(ensureProjectWorkspaceSchema, input, access, '工程工作区已核对', (request) =>
      this.projects.ensureProjectWorkspace(request)
    )
  }

  /** 只读检查已登记工程。不补建，响应不含路径或内部状态。 */
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
