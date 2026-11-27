import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'

import type {
  AppearanceSettingsVO,
  FontPresetOptionVO
} from '../vo/AppearanceSettingsVO'

export function toAppearanceSettingsVO(
  settings: AppearanceSettings,
  fontPresets: readonly FontPresetOptionVO[]
): AppearanceSettingsVO {
  return {
    fontPresetId: settings.fontPresetId,
    bodyTextSize: settings.bodyTextSize,
    glassOpacity: settings.glassOpacity,
    highContrast: settings.highContrast,
    reducedMotion: settings.reducedMotion,
    themePreset: settings.themePreset,
    fontPresets
  }
}
