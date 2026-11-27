export const AppearanceErrorCodes = {
  invalidAppearanceSettings: 1501,
  corruptAppearanceSettings: 1502,
  unsupportedAppearanceSettingsVersion: 1503,
  appearanceSettingsReadFailed: 1504,
  appearanceSettingsSaveFailed: 1505
} as const

export type AppearanceErrorCode =
  (typeof AppearanceErrorCodes)[keyof typeof AppearanceErrorCodes]

export const AppearanceErrorMessages = {
  [AppearanceErrorCodes.invalidAppearanceSettings]: '外观设置值不合法，请重新选择',
  [AppearanceErrorCodes.corruptAppearanceSettings]: '外观设置文件损坏，已使用默认外观',
  [AppearanceErrorCodes.unsupportedAppearanceSettingsVersion]:
    '外观设置版本不受支持，已使用默认外观',
  [AppearanceErrorCodes.appearanceSettingsReadFailed]: '外观设置读取失败，已使用默认外观',
  [AppearanceErrorCodes.appearanceSettingsSaveFailed]:
    '外观设置保存失败，请检查磁盘空间或写入权限'
} as const satisfies Record<AppearanceErrorCode, string>
