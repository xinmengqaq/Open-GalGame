export type AppearanceReducedMotion = 'system' | 'on' | 'off'

export type SaveAppearanceSettingsDTO = {
  fontPresetId: string
  bodyTextSize: number
  glassOpacity: number
  highContrast: boolean
  reducedMotion: AppearanceReducedMotion
  themePreset: string
}
