import { z } from 'zod'

import { connectionSettingsSchema, listModelsSchema } from './ConnectionSettingsRequestSchema'
import type { ConnectionSettingsApplicationService } from '@application/settings/connections/services/ConnectionSettingsApplicationService'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '@application/settings/connections/vo/ConnectionSettingsVO'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '@interfaces/ipc/requestHandler'
import { type IpcRequestAccess } from '@interfaces/ipc/RequestSchema'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export class ConnectionSettingsController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly settings: ConnectionSettingsApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  getSettingsSummary(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ConnectionSettingsVO | null>> {
    return this.handle(z.undefined(), input, access, '操作成功', () =>
      this.settings.getSettingsSummary()
    )
  }

  testConnection(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ConnectionTestVO>> {
    return this.handle(connectionSettingsSchema, input, access, '连接测试成功', (request) =>
      this.settings.testConnection(request)
    )
  }

  saveSettings(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ConnectionSettingsVO>> {
    return this.handle(connectionSettingsSchema, input, access, '设置已保存', (request) =>
      this.settings.saveSettings(request)
    )
  }

  listModels(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ModelListVO>> {
    return this.handle(listModelsSchema, input, access, '操作成功', (request) =>
      this.settings.listModels(request)
    )
  }
}
