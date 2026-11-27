import type { DesktopBridge } from '@interfaces/client/DesktopBridge'

export interface AppearanceSettingsClient extends Pick<
  DesktopBridge,
  'readAppearance' | 'saveAppearance'
> {}
