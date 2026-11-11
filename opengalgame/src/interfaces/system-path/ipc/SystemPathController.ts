import type { OpenDirectoryApplicationService } from '@application/system-path/services/OpenDirectoryApplicationService'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import { openDirectorySchema } from './SystemPathRequestSchema'

export class SystemPathController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly directories: OpenDirectoryApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  openDirectory(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(openDirectorySchema, input, access, '目录已交给系统打开', async (request) => {
      await this.directories.openDirectory(request)
      return null
    })
  }
}
