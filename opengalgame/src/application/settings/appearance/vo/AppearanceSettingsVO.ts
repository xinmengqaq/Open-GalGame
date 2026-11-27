import type { AppearanceReducedMotion } from '../dto/AppearanceSettingsDTO'

export type FontPresetOptionVO = {
  id: string
  label: string
  family: string
  fallback: string
  bundled: boolean
  roles: readonly ('body' | 'dialogue' | 'title' | 'mono')[]
}

export type AppearanceSettingsVO = {
  fontPresetId: string
  bodyTextSize: number
  glassOpacity: number
  highContrast: boolean
  reducedMotion: AppearanceReducedMotion
  themePreset: string
  fontPresets: readonly FontPresetOptionVO[]
}
