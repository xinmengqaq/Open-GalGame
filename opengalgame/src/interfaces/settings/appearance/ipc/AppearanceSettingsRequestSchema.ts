import { z } from 'zod'

export const saveAppearanceSettingsSchema = z.strictObject({
  fontPresetId: z.string(),
  bodyTextSize: z.number(),
  glassOpacity: z.number(),
  highContrast: z.boolean(),
  reducedMotion: z.enum(['system', 'on', 'off']),
  themePreset: z.string()
})
