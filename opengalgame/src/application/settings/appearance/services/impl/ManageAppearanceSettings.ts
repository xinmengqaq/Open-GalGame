import { AppException } from '@common/errors/AppException'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'
import {
  createDefaultAppearanceSettings,
  resolveAppearanceSettings
} from '@domain/settings/appearance/services/resolveAppearanceSettings'

import type { SaveAppearanceSettingsDTO } from '../../dto/AppearanceSettingsDTO'
import { toAppearanceSettingsVO } from '../../mapping/AppearanceSettingsMapper'
import { FONT_PRESET_OPTIONS } from '../../models/FontPresetCatalog'
import type { AppearanceSettingsGateway } from '../../ports/AppearanceSettingsGateway'
import type { AppearanceSettingsVO } from '../../vo/AppearanceSettingsVO'
import type { AppearanceSettingsApplicationService } from '../AppearanceSettingsApplicationService'

interface AppearanceSettingsDependencies {
  readonly settings: AppearanceSettingsGateway
  readonly logger: LoggerGateway
}

const appearanceReadFallbackMessage = '外观设置读取失败，已使用默认外观'

export class ManageAppearanceSettings implements AppearanceSettingsApplicationService {
  constructor(private readonly deps: AppearanceSettingsDependencies) {}

  async readAppearance(): Promise<AppearanceSettingsVO> {
    let settings: AppearanceSettings
    try {
      const saved = await this.deps.settings.read()
      settings =
        saved === null ? createDefaultAppearanceSettings() : resolveAppearanceSettings(saved)
    } catch (error) {
      if (!(error instanceof AppException)) throw error
      this.deps.logger.warn(appearanceReadFallbackMessage, {
        stage: 'appearance:read',
        category: 'appearance',
        errorCode: error.code,
        errorName: error.name
      })
      settings = createDefaultAppearanceSettings()
    }
    return toAppearanceSettingsVO(settings, FONT_PRESET_OPTIONS)
  }

  async saveAppearance(request: SaveAppearanceSettingsDTO): Promise<AppearanceSettingsVO> {
    const settings = resolveAppearanceSettings({
      fontPresetId: request.fontPresetId,
      bodyTextSize: request.bodyTextSize,
      glassOpacity: request.glassOpacity,
      highContrast: request.highContrast,
      reducedMotion: request.reducedMotion,
      themePreset: request.themePreset
    })
    await this.deps.settings.save(settings)
    return toAppearanceSettingsVO(settings, FONT_PRESET_OPTIONS)
  }
}
