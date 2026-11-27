// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { toast } from 'sonner'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type {
  AppearanceSettingsVO,
  FontPresetOptionVO
} from '@application/settings/appearance/vo/AppearanceSettingsVO'
import type { AppearanceSettingsClient } from '@interfaces/settings/appearance/client/AppearanceSettingsClient'
import {
  applyAppearanceTokens,
  bodyTextSizeValueText,
  deriveSoftGlassOpacity,
  describeBodyTextSize,
  isLocalFontFamilyAvailable,
  resolveAppearanceState,
  resolveEffectiveGlassOpacities,
  stripFamilyFromFontStack,
  type FontAvailabilityProbe
} from '@presentation/features/settings/appearance/appearanceTokens'
import {
  useAppearanceSettings,
  type AppearanceFlow
} from '@presentation/features/settings/appearance/useAppearanceSettings'
import { resolveInitialSettingsSection } from '@presentation/features/settings/settingsNavigation'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
  return { toast }
})

const fontPresets: readonly FontPresetOptionVO[] = [
  {
    id: 'system',
    label: '系统字体',
    family: 'system-ui',
    fallback: 'system-ui, sans-serif',
    bundled: false,
    roles: ['body']
  },
  {
    id: 'lxgw-wenkai-gb',
    label: '霞鹜文楷 GB',
    family: 'LXGW WenKai GB',
    fallback: 'system-ui, sans-serif',
    bundled: false,
    roles: ['dialogue']
  }
]

function makeVO(overrides: Partial<AppearanceSettingsVO> = {}): AppearanceSettingsVO {
  return {
    fontPresetId: 'system',
    bodyTextSize: 15,
    glassOpacity: 70,
    highContrast: false,
    reducedMotion: 'system',
    themePreset: 'default',
    fontPresets,
    ...overrides
  }
}

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function Probe({
  client,
  expose,
  probe
}: {
  client: AppearanceSettingsClient
  expose: (flow: AppearanceFlow) => void
  probe?: FontAvailabilityProbe
}): ReactElement | null {
  expose(useAppearanceSettings(client, probe))
  return null
}

describe('settings presentation', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-font-preset')
    document.documentElement.removeAttribute('data-high-contrast')
    document.documentElement.removeAttribute('data-reduced-motion')
    document.documentElement.removeAttribute('data-appearance-theme')
    document.documentElement.style.cssText = ''
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('derives soft glass and high-contrast floors accurately', () => {
    expect(deriveSoftGlassOpacity(70)).toBe(45)
    expect(resolveEffectiveGlassOpacities(70, false)).toEqual({
      glassOpacity: 70,
      glassSoftOpacity: 45
    })
    expect(resolveEffectiveGlassOpacities(50, true)).toEqual({
      glassOpacity: 85,
      glassSoftOpacity: 70
    })
  })

  it('applies shell CSS variables and attributes and falls back when unbundled font is missing', () => {
    const state = applyAppearanceTokens(
      {
        fontPresetId: 'lxgw-wenkai-gb',
        bodyTextSize: 18,
        glassOpacity: 60,
        highContrast: true,
        reducedMotion: 'on',
        themePreset: 'default'
      },
      fontPresets,
      undefined,
      () => false
    )
    expect(state.fontAvailable).toBe(false)
    expect(state.fontFamily).toBe('system-ui, sans-serif')
    expect(document.documentElement.dataset.fontPreset).toBe('lxgw-wenkai-gb')
    expect(document.documentElement.dataset.highContrast).toBe('true')
    expect(document.documentElement.dataset.reducedMotion).toBe('reduce')
    expect(document.documentElement.dataset.appearanceTheme).toBe('default')
    expect(document.documentElement.style.getPropertyValue('--body-text-size')).toBe('18px')
    expect(document.documentElement.style.getPropertyValue('--body-line-height')).toBe('28.8px')
    expect(document.documentElement.style.getPropertyValue('--glass-opacity')).toBe('85%')
    expect(document.documentElement.style.getPropertyValue('--glass-soft-opacity')).toBe('70%')

    const explicitOff = resolveAppearanceState(
      {
        fontPresetId: 'system',
        bodyTextSize: 15,
        glassOpacity: 70,
        highContrast: false,
        reducedMotion: 'off',
        themePreset: 'default'
      },
      fontPresets
    )
    expect(explicitOff.reducedMotion).toBe('full')
  })

  it('detects local fonts by measured width differences instead of document.fonts.check', () => {
    const absentMeasure = (): number => 100
    expect(
      isLocalFontFamilyAvailable('Missing Local Font', 'system-ui, sans-serif', absentMeasure)
    ).toBe(false)

    const presentMeasure = (font: string, text: string): number =>
      font.includes('"Present Local Font"') && text.includes('永') ? 108 : 100
    expect(
      isLocalFontFamilyAvailable('Present Local Font', 'system-ui, sans-serif', presentMeasure)
    ).toBe(true)
  })

  it('strips a preset family from the comparison stack before measuring', () => {
    expect(
      stripFamilyFromFontStack(
        '"Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
        'Source Han Sans SC'
      )
    ).toBe('"Noto Sans CJK SC", sans-serif')

    const installedMeasure = (font: string): number =>
      font.includes('"Source Han Sans SC"') ? 108 : 100
    expect(
      isLocalFontFamilyAvailable(
        'Source Han Sans SC',
        '"Source Han Sans SC", sans-serif',
        installedMeasure
      )
    ).toBe(true)
  })

  it('describes body text sizes with semantic levels and no visible pixel unit', () => {
    expect(describeBodyTextSize(12).label).toBe('偏小')
    expect(describeBodyTextSize(15).label).toBe('标准')
    expect(describeBodyTextSize(19).label).toBe('舒适')
    expect(describeBodyTextSize(24).label).toBe('大字')
    expect(bodyTextSizeValueText(18)).toBe('字号 18，舒适')
    expect(bodyTextSizeValueText(18)).not.toContain('px')
  })

  it('reports selected font availability through an injected probe', async () => {
    const client: AppearanceSettingsClient = {
      readAppearance: vi.fn().mockResolvedValue(ok(makeVO())),
      saveAppearance: vi.fn()
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let flow!: AppearanceFlow

    await act(async () => {
      root.render(
        createElement(Probe, {
          client,
          probe: (preset) => preset.id === 'system',
          expose: (next) => (flow = next)
        })
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(flow.selectedFontAvailable).toBe(true)
    act(() => {
      flow.setFontPresetId('lxgw-wenkai-gb')
    })
    expect(flow.selectedFontAvailable).toBe(false)

    await act(async () => {
      root.unmount()
    })
  })

  it('handles 5102 save failure without optimistic baseline update and supports reload', async () => {
    const readAppearance = vi
      .fn<AppearanceSettingsClient['readAppearance']>()
      .mockResolvedValueOnce(ok(makeVO()))
      .mockResolvedValueOnce(ok(makeVO({ bodyTextSize: 19 })))
    const saveAppearance = vi
      .fn<AppearanceSettingsClient['saveAppearance']>()
      .mockResolvedValueOnce({ code: ErrorCodes.communicationFailed, msg: '通信超时' })
    const client: AppearanceSettingsClient = { readAppearance, saveAppearance }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let flow!: AppearanceFlow

    await act(async () => {
      root.render(createElement(Probe, { client, expose: (next) => (flow = next) }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(flow.loadState).toBe('ready')
    act(() => {
      flow.setBodyTextFromInput('25')
    })
    expect(flow.bodyTextError).not.toBeNull()
    expect(flow.canSave).toBe(false)

    act(() => {
      flow.setBodyTextFromInput('19')
    })
    expect(flow.bodyTextError).toBeNull()
    expect(flow.canSave).toBe(true)

    let saved = true
    await act(async () => {
      saved = await flow.save()
    })
    expect(saved).toBe(false)
    expect(flow.saveFailure?.ambiguous).toBe(true)
    expect(flow.dirty).toBe(true)
    expect(toast.loading).toHaveBeenCalledWith(
      '正在保存外观…',
      expect.objectContaining({ id: 'appearance-save-result' })
    )
    expect(toast.dismiss).toHaveBeenCalledWith('appearance-save-result')

    act(() => {
      flow.dismissSaveFailure()
    })
    expect(flow.saveFailure).toBeNull()
    expect(flow.dirty).toBe(true)

    await act(async () => {
      await flow.reloadAfterSaveConflict()
    })
    expect(flow.saveFailure).toBeNull()
    expect(flow.draft.bodyTextSize).toBe(19)
    expect(flow.dirty).toBe(false)

    await act(async () => {
      root.unmount()
    })
  })

  it('routes unconfigured model straight to connection section', () => {
    expect(resolveInitialSettingsSection(undefined, false)).toBe('connection')
    expect(resolveInitialSettingsSection(undefined, true)).toBe('appearance')
    expect(resolveInitialSettingsSection('guide-update', false)).toBe('guide-update')
  })
})
