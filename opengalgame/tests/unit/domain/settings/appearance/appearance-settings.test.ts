import { describe, expect, it } from 'vitest'

import {
  AppearanceErrorCodes,
  AppearanceErrorMessages
} from '@domain/settings/appearance/errors/AppearanceErrorCodes'
import {
  appearanceFontPresetIds,
  type AppearanceSettings
} from '@domain/settings/appearance/models/AppearanceSettings'
import {
  createDefaultAppearanceSettings,
  resolveAppearanceSettings
} from '@domain/settings/appearance/services/resolveAppearanceSettings'

const validSettings: AppearanceSettings = {
  fontPresetId: 'lxgw-wenkai-gb',
  bodyTextSize: 20,
  glassOpacity: 85,
  highContrast: true,
  reducedMotion: 'on',
  themePreset: 'default'
}

const invalidSettings: { name: string; candidate: AppearanceSettings }[] = [
  {
    name: '空字体标识',
    candidate: { ...validSettings, fontPresetId: '' }
  },
  {
    name: '未登记字体标识',
    candidate: { ...validSettings, fontPresetId: 'not-registered' }
  },
  {
    name: '字号小于下限',
    candidate: { ...validSettings, bodyTextSize: 11 }
  },
  {
    name: '字号大于上限',
    candidate: { ...validSettings, bodyTextSize: 25 }
  },
  {
    name: '字号非整数',
    candidate: { ...validSettings, bodyTextSize: 15.5 }
  },
  {
    name: '透明度小于下限',
    candidate: { ...validSettings, glassOpacity: 39 }
  },
  {
    name: '透明度大于上限',
    candidate: { ...validSettings, glassOpacity: 91 }
  },
  {
    name: '透明度不按步长',
    candidate: { ...validSettings, glassOpacity: 71 }
  },
  {
    name: '透明度非整数',
    candidate: { ...validSettings, glassOpacity: 70.5 }
  },
  {
    name: '高对比非布尔值',
    candidate: { ...validSettings, highContrast: 'true' as unknown as boolean }
  },
  {
    name: '未登记的动态效果',
    candidate: {
      ...validSettings,
      reducedMotion: 'auto' as unknown as AppearanceSettings['reducedMotion']
    }
  },
  {
    name: '未知主题',
    candidate: { ...validSettings, themePreset: 'dark' }
  }
]

describe('外观设置领域规则', () => {
  it('默认构造返回完整的 system/15/70/false/system/default', () => {
    expect(createDefaultAppearanceSettings()).toEqual({
      fontPresetId: 'system',
      bodyTextSize: 15,
      glassOpacity: 70,
      highContrast: false,
      reducedMotion: 'system',
      themePreset: 'default'
    })
  })

  it('登记五个稳定字体标识，系统字体为首项', () => {
    expect(appearanceFontPresetIds).toEqual([
      'system',
      'source-han-sans',
      'source-han-serif',
      'lxgw-wenkai-gb',
      'smiley-sans'
    ])
  })

  it.each([...appearanceFontPresetIds])('接受已登记字体 %s', (fontPresetId) => {
    expect(
      resolveAppearanceSettings({
        ...validSettings,
        fontPresetId
      })
    ).toEqual({ ...validSettings, fontPresetId })
  })

  it.each([
    { bodyTextSize: 12, glassOpacity: 40 },
    { bodyTextSize: 24, glassOpacity: 90 },
    { bodyTextSize: 15, glassOpacity: 70 }
  ])(
    '接受字号 $bodyTextSize 与透明度 $glassOpacity 的边界整数',
    ({ bodyTextSize, glassOpacity }) => {
      expect(resolveAppearanceSettings({ ...validSettings, bodyTextSize, glassOpacity })).toEqual({
        ...validSettings,
        bodyTextSize,
        glassOpacity
      })
    }
  )

  it.each(['system', 'on', 'off'] as const)('接受动态效果 %s', (reducedMotion) => {
    expect(resolveAppearanceSettings({ ...validSettings, reducedMotion })).toEqual({
      ...validSettings,
      reducedMotion
    })
  })

  it('校验通过时只返回六项领域值', () => {
    const resolved = resolveAppearanceSettings({
      ...validSettings,
      fontPresets: []
    } as AppearanceSettings)

    expect(Object.keys(resolved)).toHaveLength(6)
    expect(resolved).not.toHaveProperty('fontPresets')
    expect(resolved).toEqual(validSettings)
  })

  it.each(invalidSettings)('拒绝$name', ({ candidate }) => {
    expect(() => resolveAppearanceSettings(candidate)).toThrowError(
      expect.objectContaining({
        code: AppearanceErrorCodes.invalidAppearanceSettings,
        message: AppearanceErrorMessages[AppearanceErrorCodes.invalidAppearanceSettings]
      })
    )
  })

  it('拒绝缺失的保存字段，不补默认值', () => {
    const candidate = { ...validSettings, glassOpacity: undefined } as unknown as AppearanceSettings
    expect(() => resolveAppearanceSettings(candidate)).toThrowError(
      expect.objectContaining({ code: AppearanceErrorCodes.invalidAppearanceSettings })
    )
  })

  it('错误消息使用安全文案，不包含用户原始值', () => {
    expect(() =>
      resolveAppearanceSettings({ ...validSettings, themePreset: 'secret-theme' })
    ).toThrowError(
      expect.objectContaining({
        message: '外观设置值不合法，请重新选择'
      })
    )
    try {
      resolveAppearanceSettings({ ...validSettings, themePreset: 'secret-theme' })
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-theme')
    }
  })
})
