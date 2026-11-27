import type { SaveAppearanceSettingsDTO } from '@application/settings/appearance/dto/AppearanceSettingsDTO'
import type {
  AppearanceSettingsVO,
  FontPresetOptionVO
} from '@application/settings/appearance/vo/AppearanceSettingsVO'

export type AppearanceValues = SaveAppearanceSettingsDTO

export const DEFAULT_SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'

export const DEFAULT_APPEARANCE_VALUES: AppearanceValues = {
  fontPresetId: 'system',
  bodyTextSize: 15,
  glassOpacity: 70,
  highContrast: false,
  reducedMotion: 'system',
  themePreset: 'default'
}

export interface AppliedAppearanceState {
  fontPresetId: string
  fontAvailable: boolean
  fontFamily: string
  bodyTextSize: number
  bodyLineHeight: number
  glassOpacity: number
  glassSoftOpacity: number
  highContrast: boolean
  reducedMotion: 'reduce' | 'full'
  themePreset: string
}

export function deriveSoftGlassOpacity(glassOpacity: number): number {
  return Math.round(glassOpacity * 0.64)
}

export function resolveEffectiveGlassOpacities(
  glassOpacity: number,
  highContrast: boolean
): { glassOpacity: number; glassSoftOpacity: number } {
  const soft = deriveSoftGlassOpacity(glassOpacity)
  if (!highContrast) {
    return { glassOpacity, glassSoftOpacity: soft }
  }
  return {
    glassOpacity: Math.max(glassOpacity, 85),
    glassSoftOpacity: Math.max(soft, 70)
  }
}

export type TextWidthMeasurer = (font: string, text: string) => number
export type FontAvailabilityProbe = (preset: FontPresetOptionVO) => boolean

const FONT_PROBE_SAMPLES = ['永和九年岁在癸丑 AaBbGg019', '把心动写成可以选择的故事。'] as const
const FONT_PROBE_SIZES = [16, 24] as const
const FONT_PROBE_THRESHOLD = 0.5

/** 回退栈可能包含与预设同名的字族（如思源黑体），比较前要移除才能测出真实安装状态。 */
export function stripFamilyFromFontStack(stack: string, family: string): string {
  const normalizedFamily = family.replace(/["']/g, '').trim().toLowerCase()
  const kept = stack
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => part.replace(/["']/g, '').trim().toLowerCase() !== normalizedFamily)
  return kept.length > 0 ? kept.join(', ') : 'sans-serif'
}

/**
 * 本地字体没有注册 @font-face，`document.fonts.check` 会对缺失字族也返回 true。
 * 用候选字族与回退栈的文本宽度差判断是否真正生效（拉丁与中文、两个字号都测）。
 */
export function isLocalFontFamilyAvailable(
  family: string,
  fallback: string,
  measure: TextWidthMeasurer
): boolean {
  if (!family) return false
  const fallbackStack = fallback || DEFAULT_SYSTEM_FONT_STACK
  const baselineStack = stripFamilyFromFontStack(fallbackStack, family)
  try {
    return FONT_PROBE_SIZES.some((size) =>
      FONT_PROBE_SAMPLES.some((sample) => {
        const candidate = measure(`${size}px "${family}", ${fallbackStack}`, sample)
        const baseline = measure(`${size}px ${baselineStack}`, sample)
        return Math.abs(candidate - baseline) > FONT_PROBE_THRESHOLD
      })
    )
  } catch {
    return true
  }
}

let canvasMeasurer: TextWidthMeasurer | null | undefined
const localFontAvailabilityCache = new Map<string, boolean>()

function createCanvasMeasurer(): TextWidthMeasurer | null {
  if (typeof document === 'undefined') return null
  try {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return null
    return (font, text) => {
      context.font = font
      return context.measureText(text).width
    }
  } catch {
    return null
  }
}

function getCanvasMeasurer(): TextWidthMeasurer | null {
  if (canvasMeasurer === undefined) canvasMeasurer = createCanvasMeasurer()
  return canvasMeasurer
}

/** 字体加载完成后重新探测；在应用运行中安装字体也需要一次新的读取。 */
export function clearLocalFontProbeCache(): void {
  localFontAvailabilityCache.clear()
}

export const probeLocalFontAvailability: FontAvailabilityProbe = (preset) => {
  if (preset.id === 'system' || preset.bundled) return true
  const cached = localFontAvailabilityCache.get(preset.family)
  if (cached !== undefined) return cached
  const measure = getCanvasMeasurer()
  if (!measure) return true
  const available = isLocalFontFamilyAvailable(preset.family, preset.fallback, measure)
  localFontAvailabilityCache.set(preset.family, available)
  return available
}

export function isSystemFontAvailable(
  preset: FontPresetOptionVO | undefined,
  probe: FontAvailabilityProbe = probeLocalFontAvailability
): boolean {
  if (!preset || preset.id === 'system' || preset.bundled) return true
  try {
    return probe(preset)
  } catch {
    return true
  }
}

export interface BodyTextSizeLevel {
  label: string
  description: string
}

const BODY_TEXT_SIZE_LEVELS: ReadonlyArray<{
  max: number
  label: string
  description: string
}> = [
  { max: 13, label: '偏小', description: '更紧凑的阅读字号' },
  { max: 16, label: '标准', description: '默认的阅读字号' },
  { max: 20, label: '舒适', description: '更舒展的阅读字号' },
  { max: 24, label: '大字', description: '最大阅读字号' }
]

/** 可见界面只呈现语义档位；底层仍以 12～24 的数值保存。 */
export function describeBodyTextSize(size: number): BodyTextSizeLevel {
  const level = BODY_TEXT_SIZE_LEVELS.find((item) => size <= item.max) ?? BODY_TEXT_SIZE_LEVELS[0]
  return { label: level.label, description: level.description }
}

export function bodyTextSizeValueText(size: number): string {
  return `字号 ${size}，${describeBodyTextSize(size).label}`
}

export function resolveShellFontFamily(
  preset: FontPresetOptionVO | undefined,
  available: boolean
): string {
  if (!preset || preset.id === 'system' || !available) {
    return preset?.fallback || DEFAULT_SYSTEM_FONT_STACK
  }
  const fallback = preset.fallback || DEFAULT_SYSTEM_FONT_STACK
  return `"${preset.family}", ${fallback}`
}

export function resolveEffectiveReducedMotion(
  preference: AppearanceValues['reducedMotion'],
  matchMedia: ((query: string) => MediaQueryList) | undefined = typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function'
    ? window.matchMedia.bind(window)
    : undefined
): 'reduce' | 'full' {
  if (preference === 'on') return 'reduce'
  if (preference === 'off') return 'full'
  if (!matchMedia) return 'full'
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'full'
}

export function resolveAppearanceState(
  values: AppearanceValues,
  fontPresets: readonly FontPresetOptionVO[],
  probe: FontAvailabilityProbe = probeLocalFontAvailability
): AppliedAppearanceState {
  const preset = fontPresets.find((item) => item.id === values.fontPresetId)
  const fontAvailable = isSystemFontAvailable(preset, probe)
  const fontFamily = resolveShellFontFamily(preset, fontAvailable)
  const { glassOpacity, glassSoftOpacity } = resolveEffectiveGlassOpacities(
    values.glassOpacity,
    values.highContrast
  )
  return {
    fontPresetId: values.fontPresetId,
    fontAvailable,
    fontFamily,
    bodyTextSize: values.bodyTextSize,
    bodyLineHeight: Math.round(values.bodyTextSize * 1.6 * 100) / 100,
    glassOpacity,
    glassSoftOpacity,
    highContrast: values.highContrast,
    reducedMotion: resolveEffectiveReducedMotion(values.reducedMotion),
    themePreset: values.themePreset
  }
}

export function applyAppearanceTokens(
  values: AppearanceValues,
  fontPresets: readonly FontPresetOptionVO[],
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
  probe: FontAvailabilityProbe = probeLocalFontAvailability
): AppliedAppearanceState {
  const resolved = resolveAppearanceState(values, fontPresets, probe)
  if (!root) return resolved
  root.dataset.fontPreset = resolved.fontPresetId
  root.dataset.highContrast = resolved.highContrast ? 'true' : 'false'
  root.dataset.reducedMotion = resolved.reducedMotion
  root.dataset.appearanceTheme = resolved.themePreset
  root.style.setProperty('--font-shell', resolved.fontFamily)
  root.style.setProperty('--font-sans', resolved.fontFamily)
  root.style.setProperty('--body-text-size', `${resolved.bodyTextSize}px`)
  root.style.setProperty('--body-line-height', `${resolved.bodyLineHeight}px`)
  root.style.setProperty('--glass-opacity', `${resolved.glassOpacity}%`)
  root.style.setProperty('--glass-soft-opacity', `${resolved.glassSoftOpacity}%`)
  return resolved
}

export function pickAppearanceValues(vo: AppearanceSettingsVO): AppearanceValues {
  return {
    fontPresetId: vo.fontPresetId,
    bodyTextSize: vo.bodyTextSize,
    glassOpacity: vo.glassOpacity,
    highContrast: vo.highContrast,
    reducedMotion: vo.reducedMotion,
    themePreset: vo.themePreset
  }
}

export function isSameAppearanceValues(a: AppearanceValues, b: AppearanceValues): boolean {
  return (
    a.fontPresetId === b.fontPresetId &&
    a.bodyTextSize === b.bodyTextSize &&
    a.glassOpacity === b.glassOpacity &&
    a.highContrast === b.highContrast &&
    a.reducedMotion === b.reducedMotion &&
    a.themePreset === b.themePreset
  )
}
