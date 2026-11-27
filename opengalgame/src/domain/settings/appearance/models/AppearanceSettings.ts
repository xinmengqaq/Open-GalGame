export type AppearanceReducedMotionPreference = 'system' | 'on' | 'off'

export const appearanceFontPresetIds = [
  'system',
  'source-han-sans',
  'source-han-serif',
  'lxgw-wenkai-gb',
  'smiley-sans'
] as const

export type AppearanceFontPresetId = (typeof appearanceFontPresetIds)[number]

export type AppearanceSettings = {
  readonly fontPresetId: string
  readonly bodyTextSize: number
  readonly glassOpacity: number
  readonly highContrast: boolean
  readonly reducedMotion: AppearanceReducedMotionPreference
  readonly themePreset: string
}
