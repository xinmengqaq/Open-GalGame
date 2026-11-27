import { AppException } from '@common/errors/AppException'

import {
  AppearanceErrorCodes,
  AppearanceErrorMessages
} from '../errors/AppearanceErrorCodes'
import {
  appearanceFontPresetIds,
  type AppearanceReducedMotionPreference,
  type AppearanceSettings
} from '../models/AppearanceSettings'

const allowedReducedMotionValues: Record<AppearanceReducedMotionPreference, true> = {
  system: true,
  on: true,
  off: true
}

export function createDefaultAppearanceSettings(): AppearanceSettings {
  return {
    fontPresetId: 'system',
    bodyTextSize: 15,
    glassOpacity: 70,
    highContrast: false,
    reducedMotion: 'system',
    themePreset: 'default'
  }
}

export function resolveAppearanceSettings(candidate: AppearanceSettings): AppearanceSettings {
  if (
    !appearanceFontPresetIds.some((id) => id === candidate.fontPresetId) ||
    !Number.isInteger(candidate.bodyTextSize) ||
    candidate.bodyTextSize < 12 ||
    candidate.bodyTextSize > 24 ||
    !Number.isInteger(candidate.glassOpacity) ||
    candidate.glassOpacity < 40 ||
    candidate.glassOpacity > 90 ||
    candidate.glassOpacity % 5 !== 0 ||
    typeof candidate.highContrast !== 'boolean' ||
    allowedReducedMotionValues[candidate.reducedMotion] !== true ||
    candidate.themePreset !== 'default'
  )
    throw new AppException({
      code: AppearanceErrorCodes.invalidAppearanceSettings,
      msg: AppearanceErrorMessages[AppearanceErrorCodes.invalidAppearanceSettings]
    })
  return {
    fontPresetId: candidate.fontPresetId,
    bodyTextSize: candidate.bodyTextSize,
    glassOpacity: candidate.glassOpacity,
    highContrast: candidate.highContrast,
    reducedMotion: candidate.reducedMotion,
    themePreset: candidate.themePreset
  }
}
