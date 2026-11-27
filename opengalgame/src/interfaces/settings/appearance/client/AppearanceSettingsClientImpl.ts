import type { SaveAppearanceSettingsDTO } from '@application/settings/appearance/dto/AppearanceSettingsDTO'
import type { AppearanceSettingsVO } from '@application/settings/appearance/vo/AppearanceSettingsVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { invokeAjaxResult } from '@interfaces/client/communicationFailure'

import type { AppearanceSettingsClient } from './AppearanceSettingsClient'

export class AppearanceSettingsClientImpl implements AppearanceSettingsClient {
  constructor(private readonly bridge: DesktopBridge) {}

  readAppearance(): Promise<AjaxResult<AppearanceSettingsVO>> {
    return invokeAjaxResult(() => this.bridge.readAppearance())
  }

  saveAppearance(request: SaveAppearanceSettingsDTO): Promise<AjaxResult<AppearanceSettingsVO>> {
    return invokeAjaxResult(() => this.bridge.saveAppearance(request))
  }
}
