import type { SaveAppearanceSettingsDTO } from '../dto/AppearanceSettingsDTO'
import type { AppearanceSettingsVO } from '../vo/AppearanceSettingsVO'

export interface AppearanceSettingsApplicationService {
  readAppearance(): Promise<AppearanceSettingsVO>

  saveAppearance(request: SaveAppearanceSettingsDTO): Promise<AppearanceSettingsVO>
}
