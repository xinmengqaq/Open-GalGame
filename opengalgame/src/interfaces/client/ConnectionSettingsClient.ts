import type { DesktopBridge } from './DesktopBridge'
export interface ConnectionSettingsClient extends Pick<
  DesktopBridge,
  'getSettingsSummary' | 'testConnection' | 'saveSettings' | 'listModels'
> {}
