import type { DesktopBridge } from '@interfaces/client/DesktopBridge'

export interface ConnectionSettingsClient extends Pick<
  DesktopBridge,
  'getSettingsSummary' | 'testConnection' | 'saveSettings' | 'listModels'
> {}
