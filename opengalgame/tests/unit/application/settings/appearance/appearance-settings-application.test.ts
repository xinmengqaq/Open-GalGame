import { describe, expect, it, vi } from 'vitest'

import type { SaveAppearanceSettingsDTO } from '@application/settings/appearance/dto/AppearanceSettingsDTO'
import { FONT_PRESET_OPTIONS } from '@application/settings/appearance/models/FontPresetCatalog'
import { ManageAppearanceSettings } from '@application/settings/appearance/services/impl/ManageAppearanceSettings'
import { AppException } from '@common/errors/AppException'
import {
  AppearanceErrorCodes,
  AppearanceErrorMessages
} from '@domain/settings/appearance/errors/AppearanceErrorCodes'
import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'
import { createDefaultAppearanceSettings } from '@domain/settings/appearance/services/resolveAppearanceSettings'

const savedSettings: AppearanceSettings = {
  fontPresetId: 'source-han-serif',
  bodyTextSize: 18,
  glassOpacity: 55,
  highContrast: true,
  reducedMotion: 'off',
  themePreset: 'default'
}

const saveRequest: SaveAppearanceSettingsDTO = {
  fontPresetId: 'smiley-sans',
  bodyTextSize: 22,
  glassOpacity: 45,
  highContrast: false,
  reducedMotion: 'on',
  themePreset: 'default'
}

interface HarnessOptions {
  saved?: AppearanceSettings | null
  readError?: unknown
}

function createHarness({ saved = null, readError }: HarnessOptions = {}) {
  const settings = {
    read: vi.fn(async () => {
      if (readError !== undefined) throw readError
      return saved
    }),
    save: vi.fn<(settings: AppearanceSettings) => Promise<void>>(async () => undefined)
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
  return {
    settings,
    logger,
    service: new ManageAppearanceSettings({ settings, logger })
  }
}

const invalidSaveRequests: { name: string; request: SaveAppearanceSettingsDTO }[] = [
  {
    name: '字号大于上限',
    request: { ...saveRequest, bodyTextSize: 25 }
  },
  {
    name: '字号非整数',
    request: { ...saveRequest, bodyTextSize: 15.5 }
  },
  {
    name: '透明度不按步长',
    request: { ...saveRequest, glassOpacity: 72 }
  },
  {
    name: '未登记字体',
    request: { ...saveRequest, fontPresetId: 'not-registered' }
  },
  {
    name: '未知主题',
    request: { ...saveRequest, themePreset: 'dark' }
  },
  {
    name: '未登记的动态效果',
    request: {
      ...saveRequest,
      reducedMotion: 'auto' as unknown as SaveAppearanceSettingsDTO['reducedMotion']
    }
  },
  {
    name: '缺失字段',
    request: {
      ...saveRequest,
      highContrast: undefined as unknown as boolean
    }
  }
]

const readFallbacks: { name: string; code: number }[] = [
  { name: '文件损坏', code: AppearanceErrorCodes.corruptAppearanceSettings },
  { name: '版本不受支持', code: AppearanceErrorCodes.unsupportedAppearanceSettingsVersion },
  { name: '读取失败', code: AppearanceErrorCodes.appearanceSettingsReadFailed }
]

describe('外观设置应用用例', () => {
  it('文件缺失时返回默认外观，不写盘也不告警', async () => {
    const { service, settings, logger } = createHarness()

    const vo = await service.readAppearance()

    expect(vo).toEqual({
      ...createDefaultAppearanceSettings(),
      fontPresets: FONT_PRESET_OPTIONS
    })
    expect(settings.read).toHaveBeenCalledTimes(1)
    expect(settings.save).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('已保存值返回完整六项和字体目录，不重复读取', async () => {
    const { service, settings, logger } = createHarness({ saved: savedSettings })

    const vo = await service.readAppearance()

    expect(vo).toEqual({ ...savedSettings, fontPresets: FONT_PRESET_OPTIONS })
    expect(settings.read).toHaveBeenCalledTimes(1)
    expect(settings.save).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each(readFallbacks)('读取$name时回退默认并只告警一次', async ({ code }) => {
    const readError = new AppException({
      code,
      msg: AppearanceErrorMessages[code as keyof typeof AppearanceErrorMessages]
    })
    const { service, settings, logger } = createHarness({ readError })

    const vo = await service.readAppearance()

    expect(vo).toEqual({
      ...createDefaultAppearanceSettings(),
      fontPresets: FONT_PRESET_OPTIONS
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('外观设置读取失败，已使用默认外观', {
      stage: 'appearance:read',
      category: 'appearance',
      errorCode: code,
      errorName: 'AppException'
    })
    expect(settings.save).not.toHaveBeenCalled()
  })

  it('已保存值违反领域规则时回退默认并只告警一次', async () => {
    const { service, settings, logger } = createHarness({
      saved: { ...savedSettings, glassOpacity: 72 }
    })

    const vo = await service.readAppearance()

    expect(vo).toEqual({
      ...createDefaultAppearanceSettings(),
      fontPresets: FONT_PRESET_OPTIONS
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('外观设置读取失败，已使用默认外观', {
      stage: 'appearance:read',
      category: 'appearance',
      errorCode: AppearanceErrorCodes.invalidAppearanceSettings,
      errorName: 'AppException'
    })
    expect(settings.save).not.toHaveBeenCalled()
  })

  it('非 AppException 读取异常直接透传，不伪装成默认外观', async () => {
    const readError = new TypeError('read failed')
    const { service, logger } = createHarness({ readError })

    await expect(service.readAppearance()).rejects.toBe(readError)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('保存时只校验完整六项并写入一次，不读取旧值', async () => {
    const { service, settings, logger } = createHarness({ saved: savedSettings })

    const vo = await service.saveAppearance(saveRequest)

    expect(settings.save).toHaveBeenCalledTimes(1)
    expect(settings.save).toHaveBeenCalledWith(saveRequest)
    expect(settings.read).not.toHaveBeenCalled()
    expect(vo).toEqual({ ...saveRequest, fontPresets: FONT_PRESET_OPTIONS })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('保存时复制六项，不把额外字段传给网关', async () => {
    const { service, settings } = createHarness()

    await service.saveAppearance({
      ...saveRequest,
      fontPresets: FONT_PRESET_OPTIONS
    } as SaveAppearanceSettingsDTO)

    expect(settings.save.mock.calls[0]?.[0]).not.toHaveProperty('fontPresets')
  })

  it.each(invalidSaveRequests)('保存时拒绝$name且不写入', async ({ request }) => {
    const { service, settings } = createHarness()

    await expect(service.saveAppearance(request)).rejects.toMatchObject({
      code: AppearanceErrorCodes.invalidAppearanceSettings,
      message: AppearanceErrorMessages[AppearanceErrorCodes.invalidAppearanceSettings]
    })
    expect(settings.save).not.toHaveBeenCalled()
  })

  it('保存失败不吞错也不回落默认值', async () => {
    const { service, settings } = createHarness()
    const saveError = new AppException({
      code: AppearanceErrorCodes.appearanceSettingsSaveFailed,
      msg: AppearanceErrorMessages[AppearanceErrorCodes.appearanceSettingsSaveFailed]
    })
    settings.save.mockRejectedValueOnce(saveError)

    await expect(service.saveAppearance(saveRequest)).rejects.toBe(saveError)
    expect(settings.save).toHaveBeenCalledTimes(1)
  })
})
