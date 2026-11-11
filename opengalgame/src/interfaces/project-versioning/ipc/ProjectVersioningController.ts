import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  clearVersionHistorySchema,
  listVersionHistorySchema,
  undoVersionHistorySchema
} from './ProjectVersioningRequestSchema'

/** 只转发用户历史用例，不组合版本步骤，也不解释历史内容。 */
export class ProjectVersioningController {
  private readonly handle: IpcRequestHandler

  /**
   * @param versioning - 版本应用服务。
   * @param exceptions - 统一失败出口。
   */
  constructor(
    private readonly versioning: ProjectVersioningApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  listHistory(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<VersionHistoryPageVO>> {
    return this.handle(listVersionHistorySchema, input, access, '历史记录读取完成', (request) =>
      this.versioning.listHistory(request)
    )
  }

  undoHistoryEntry(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<VersionHistoryUndoVO>> {
    return this.handle(undoVersionHistorySchema, input, access, '这次操作已撤销', (request) =>
      this.versioning.undoHistoryEntry(request)
    )
  }

  clearHistory(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<VersionHistoryClearVO>> {
    return this.handle(clearVersionHistorySchema, input, access, '历史记录已清理', (request) =>
      this.versioning.clearHistory(request)
    )
  }
}
