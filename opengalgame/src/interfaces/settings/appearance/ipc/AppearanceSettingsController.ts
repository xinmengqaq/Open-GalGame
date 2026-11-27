import { z } from 'zod'

import type { AppearanceSettingsApplicationService } from '@application/settings/appearance/services/AppearanceSettingsApplicationService'
import type { AppearanceSettingsVO } from '@application/settings/appearance/vo/AppearanceSettingsVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '@interfaces/ipc/requestHandler'
import { type IpcRequestAccess } from '@interfaces/ipc/RequestSchema'
import { saveAppearanceSettingsSchema } from './AppearanceSettingsRequestSchema'

export class AppearanceSettingsController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly appearance: AppearanceSettingsApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  readAppearance(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<AppearanceSettingsVO>> {
    return this.handle(z.undefined(), input, access, '外观设置已读取', () =>
      this.appearance.readAppearance()
    )
  }

  saveAppearance(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<AppearanceSettingsVO>> {
    return this.handle(saveAppearanceSettingsSchema, input, access, '外观设置已保存', (request) =>
      this.appearance.saveAppearance(request)
    )
  }
}
