import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import type { AppearanceSettingsGateway } from '@application/settings/appearance/ports/AppearanceSettingsGateway'
import { AppException } from '@common/errors/AppException'
import {
  AppearanceErrorCodes,
  AppearanceErrorMessages,
  type AppearanceErrorCode
} from '@domain/settings/appearance/errors/AppearanceErrorCodes'
import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'

import {
  mapStorageFailure,
  parseJsonDocumentContent,
  writeJsonDocument,
  type StorageFailure
} from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'

const APPEARANCE_SETTINGS_FILE_NAME = 'appearance.json'
const APPEARANCE_SETTINGS_FORMAT_VERSION = 1

const appearanceSettingsDocumentSchema = z.strictObject({
  formatVersion: z.literal(APPEARANCE_SETTINGS_FORMAT_VERSION),
  fontPresetId: z.string(),
  bodyTextSize: z.number(),
  glassOpacity: z.number(),
  highContrast: z.boolean(),
  reducedMotion: z.enum(['system', 'on', 'off']),
  themePreset: z.string()
})

type AppearanceSettingsDocument = z.infer<typeof appearanceSettingsDocumentSchema>

const corruptFailure: StorageFailure = {
  code: AppearanceErrorCodes.corruptAppearanceSettings,
  msg: AppearanceErrorMessages[AppearanceErrorCodes.corruptAppearanceSettings]
}
const unsupportedVersionFailure: StorageFailure = {
  code: AppearanceErrorCodes.unsupportedAppearanceSettingsVersion,
  msg: AppearanceErrorMessages[AppearanceErrorCodes.unsupportedAppearanceSettingsVersion]
}

function ioFailure(code: AppearanceErrorCode): StorageFailure {
  const msg = AppearanceErrorMessages[code]
  return { code, msg, diskFull: { code, msg }, notWritable: { code, msg } }
}

const readFailure = ioFailure(AppearanceErrorCodes.appearanceSettingsReadFailed)
const saveFailure = ioFailure(AppearanceErrorCodes.appearanceSettingsSaveFailed)

function readFormatVersion(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AppException(corruptFailure)
  if (!('formatVersion' in value)) throw new AppException(corruptFailure)
  const version = value.formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version))
    throw new AppException(corruptFailure)
  return version
}

export class AppearanceSettingsGatewayImpl implements AppearanceSettingsGateway {
  constructor(private readonly userDirectory: string) {}

  async read(): Promise<AppearanceSettings | null> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw mapStorageFailure(error, readFailure)
    }
    const value = parseJsonDocumentContent(content, corruptFailure)
    if (readFormatVersion(value) !== APPEARANCE_SETTINGS_FORMAT_VERSION)
      throw new AppException(unsupportedVersionFailure)
    const document = parseUnknownValue(
      appearanceSettingsDocumentSchema,
      value,
      AppearanceErrorCodes.corruptAppearanceSettings,
      AppearanceErrorMessages[AppearanceErrorCodes.corruptAppearanceSettings]
    )
    return {
      fontPresetId: document.fontPresetId,
      bodyTextSize: document.bodyTextSize,
      glassOpacity: document.glassOpacity,
      highContrast: document.highContrast,
      reducedMotion: document.reducedMotion,
      themePreset: document.themePreset
    }
  }

  async save(settings: AppearanceSettings): Promise<void> {
    const document: AppearanceSettingsDocument = {
      formatVersion: APPEARANCE_SETTINGS_FORMAT_VERSION,
      ...settings
    }
    await writeJsonDocument(this.filePath, document, saveFailure)
  }

  private get filePath(): string {
    return join(this.userDirectory, APPEARANCE_SETTINGS_FILE_NAME)
  }
}
