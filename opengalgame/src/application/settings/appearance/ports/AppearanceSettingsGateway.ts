import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'

export interface AppearanceSettingsGateway {
  read(): Promise<AppearanceSettings | null>

  save(settings: AppearanceSettings): Promise<void>
}
