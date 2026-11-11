import type { ProjectFilesApplicationService } from '@application/project-files/services/ProjectFilesApplicationService'
import type { ProjectFileOperationSettlementVO } from '@application/project-files/vo/ProjectFileOperationVO'
import type { ProjectFilesInspectionVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import type { ProjectFileChooser } from './ProjectFileChooser'
import {
  chooseProjectFilesSchema,
  copyProjectFileSchema,
  copyProjectFolderSchema,
  createProjectFolderSchema,
  createProjectTextFileSchema,
  deleteProjectFileSchema,
  deleteProjectFolderSchema,
  importProjectFilesSchema,
  inspectProjectFilesSchema,
  listProjectInputSourcesSchema,
  moveProjectFileSchema,
  projectFileScopeSchema,
  projectFolderScopeSchema,
  readProjectFileOperationSchema,
  readProjectInputSourcesSchema,
  readProjectMediaSchema,
  renameProjectFileSchema,
  renameProjectFolderSchema,
  updateProjectTextFileBodySchema
} from './ProjectFilesRequestSchema'

export class ProjectFilesController {
  private readonly handle: IpcRequestHandler

  /**
   * @param exceptions - 统一失败出口。
   */
  constructor(
    private readonly projectFiles: ProjectFilesApplicationService,
    exceptions: IpcExceptionHandler,
    private readonly chooser: ProjectFileChooser
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  /**
   * @returns 工程身份、两个格式支持事实和对象诊断。成功只表示检查完成。
   */
  inspectProjectFiles(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectFilesInspectionVO>> {
    return this.handle(inspectProjectFilesSchema, input, access, '工程文件检查完成', (request) =>
      this.projectFiles.inspectProjectFiles(request)
    )
  }

  /**
   * @returns 来源摘要。整体扫描失败不会变成空列表。
   */
  listProjectInputSources(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputCatalogVO>> {
    return this.handle(
      listProjectInputSourcesSchema,
      input,
      access,
      '输入来源扫描完成',
      (request) => this.projectFiles.listProjectInputSources(request)
    )
  }

  /**
   * @returns 完整来源快照。失败时不返回部分来源。
   */
  readProjectInputSources(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputSourcesSnapshotVO>> {
    return this.handle(
      readProjectInputSourcesSchema,
      input,
      access,
      '输入来源读取完成',
      (request) => this.projectFiles.readProjectInputSources(request)
    )
  }

  /**
   * 按来源身份读取媒体字节。请求不能携带路径。
   * @returns 媒体字节和类型。失败时不返回部分字节。
   */
  readProjectMedia(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ProjectMediaVO>> {
    return this.handle(readProjectMediaSchema, input, access, '媒体读取完成', (request) =>
      this.projectFiles.readProjectMedia(request)
    )
  }

  /**
   * 选择待导入文件。取消时 data 为 null。不调用导入。
   * @param input - 未知请求。不能携带路径。
   * @returns 路径列表或 null。
   */
  chooseProjectFiles(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<readonly string[] | null>> {
    return this.handle(chooseProjectFilesSchema, input, access, '文件选择完成', () =>
      this.chooser.chooseProjectFiles()
    )
  }

  /**
   * 导入已选择的文件。不组合选择器。
   * @returns 成功项和失败项。整体失败不夹带部分结果。
   */
  importProjectFiles(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ImportProjectFilesVO>> {
    return this.handle(importProjectFilesSchema, input, access, '导入处理完成', (request) =>
      this.projectFiles.importProjectFiles(request)
    )
  }

  /**
   * 用系统默认程序打开工程文件。
   * @returns 成功时 data 为 null。
   */
  openProjectFile(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(projectFileScopeSchema, input, access, '已请求打开文件', async (request) => {
      await this.projectFiles.openProjectFile(request)
      return null
    })
  }

  renameProjectFile(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return this.handle(renameProjectFileSchema, input, access, '文件已重命名', (request) =>
      this.projectFiles.renameProjectFile(request)
    )
  }

  /**
   * @returns 成功时 data 为 null。
   */
  deleteProjectFile(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(deleteProjectFileSchema, input, access, '文件已删除', async (request) => {
      await this.projectFiles.deleteProjectFile(request)
      return null
    })
  }

  createProjectTextFile(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return this.handle(createProjectTextFileSchema, input, access, '文本来源已创建', (request) =>
      this.projectFiles.createProjectTextFile(request)
    )
  }

  updateProjectTextFileBody(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputSourceVO>> {
    return this.handle(updateProjectTextFileBodySchema, input, access, '正文已保存', (request) =>
      this.projectFiles.updateProjectTextFileBody(request)
    )
  }

  createProjectFolder(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectFolderVO>> {
    return this.handle(createProjectFolderSchema, input, access, '文件夹已创建', (request) =>
      this.projectFiles.createProjectFolder(request)
    )
  }

  copyProjectFile(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return this.handle(copyProjectFileSchema, input, access, '文件已复制', (request) =>
      this.projectFiles.copyProjectFile(request)
    )
  }

  moveProjectFile(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectInputSourceSummaryVO>> {
    return this.handle(moveProjectFileSchema, input, access, '文件已移动', (request) =>
      this.projectFiles.moveProjectFile(request)
    )
  }

  copyProjectFolder(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectFolderVO>> {
    return this.handle(copyProjectFolderSchema, input, access, '文件夹已复制', (request) =>
      this.projectFiles.copyProjectFolder(request)
    )
  }

  renameProjectFolder(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectFolderVO>> {
    return this.handle(renameProjectFolderSchema, input, access, '文件夹已重命名', (request) =>
      this.projectFiles.renameProjectFolder(request)
    )
  }

  readProjectFolderDeletionPlan(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectFolderDeletionPlanVO>> {
    return this.handle(projectFolderScopeSchema, input, access, '删除计划已读取', (request) =>
      this.projectFiles.readProjectFolderDeletionPlan(request)
    )
  }

  readProjectFileOperation(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ProjectFileOperationSettlementVO>> {
    return this.handle(readProjectFileOperationSchema, input, access, '操作事实已核对', (request) =>
      this.projectFiles.readProjectFileOperation(request)
    )
  }

  deleteProjectFolder(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(
      deleteProjectFolderSchema,
      input,
      access,
      '文件夹已删除',
      async (request) => {
        await this.projectFiles.deleteProjectFolder(request)
        return null
      }
    )
  }
}
