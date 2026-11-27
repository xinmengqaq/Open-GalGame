export type SettingsSectionId = 'appearance' | 'connection' | 'guide-update'

export interface SettingsSectionMeta {
  id: SettingsSectionId
  label: string
}

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'appearance'
export const DIRECT_MODEL_SETTINGS_SECTION: SettingsSectionId = 'connection'

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'appearance', label: '外观与舒适度' },
  { id: 'connection', label: '模型连接' },
  { id: 'guide-update', label: '新手引导与更新' }
]

export function resolveInitialSettingsSection(
  requestedSection?: SettingsSectionId,
  modelConfigured?: boolean
): SettingsSectionId {
  if (requestedSection) return requestedSection
  if (modelConfigured === false) return DIRECT_MODEL_SETTINGS_SECTION
  return DEFAULT_SETTINGS_SECTION
}
