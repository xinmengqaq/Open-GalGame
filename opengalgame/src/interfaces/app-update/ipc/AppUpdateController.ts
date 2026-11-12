import type { AppUpdateApplicationService } from '@application/app-update/services/AppUpdateApplicationService'
import type { UpdateCheckVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import { checkForUpdateSchema, emptyUpdateRequestSchema } from './AppUpdateRequestSchema'

export class AppUpdateController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly appUpdate: AppUpdateApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  checkForUpdate(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<UpdateCheckVO>> {
    return this.handle(checkForUpdateSchema, input, access, '更新检查完成', (request) =>
      this.appUpdate.checkForUpdate(request)
    )
  }

  downloadUpdate(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<UpdateStatusVO>> {
    return this.handle(emptyUpdateRequestSchema, input, access, '更新下载已开始', (request) =>
      this.appUpdate.downloadUpdate(request)
    )
  }

  installUpdate(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(
      emptyUpdateRequestSchema,
      input,
      access,
      '正在重启安装更新',
      async (request) => {
        await this.appUpdate.installUpdate(request)
        return null
      }
    )
  }

  readUpdateStatus(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<UpdateStatusVO>> {
    return this.handle(emptyUpdateRequestSchema, input, access, '更新状态已读取', (request) =>
      this.appUpdate.readStatus(request)
    )
  }
}
