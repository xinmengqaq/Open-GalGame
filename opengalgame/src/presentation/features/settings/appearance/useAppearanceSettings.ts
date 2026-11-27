import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SaveAppearanceSettingsDTO } from '@application/settings/appearance/dto/AppearanceSettingsDTO'
import type { FontPresetOptionVO } from '@application/settings/appearance/vo/AppearanceSettingsVO'
import type { AppearanceSettingsClient } from '@interfaces/settings/appearance/client/AppearanceSettingsClient'
import {
  applyAppearanceTokens,
  clearLocalFontProbeCache,
  DEFAULT_APPEARANCE_VALUES,
  isSameAppearanceValues,
  isSystemFontAvailable,
  pickAppearanceValues,
  probeLocalFontAvailability,
  type AppearanceValues,
  type FontAvailabilityProbe
} from './appearanceTokens'

const APPEARANCE_SAVE_TOAST_ID = 'appearance-save-result'

export const BODY_TEXT_SIZE_MIN = 12
export const BODY_TEXT_SIZE_MAX = 24
export const GLASS_OPACITY_MIN = 40
export const GLASS_OPACITY_MAX = 90
export const GLASS_OPACITY_STEP = 5

export type AppearanceLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface AppearanceSaveFailure {
  code: number
  message: string
  ambiguous: boolean
}

export interface AppearanceFlow {
  loadState: AppearanceLoadState
  loadError: string | null
  saving: boolean
  saveFailure: AppearanceSaveFailure | null
  draft: AppearanceValues
  bodyTextInput: string
  bodyTextError: string | null
  fontPresets: readonly FontPresetOptionVO[]
  selectedFontAvailable: boolean
  dirty: boolean
  canSave: boolean
  load: (options?: { syncDraft?: boolean }) => Promise<void>
  retryLoad: () => Promise<void>
  reloadAfterSaveConflict: () => Promise<void>
  setFontPresetId: (value: string) => void
  setBodyTextFromSlider: (value: number) => void
  setBodyTextFromInput: (raw: string) => void
  setGlassOpacity: (value: number) => void
  setHighContrast: (value: boolean) => void
  setReducedMotion: (value: AppearanceValues['reducedMotion']) => void
  save: () => Promise<boolean>
  dismissSaveFailure: () => void
  discardChanges: () => void
}

function validateBodyTextInput(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { value: null, error: '请输入 12 到 24 之间的整数。' }
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return { value: null, error: '字号必须是整数。' }
  }
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < BODY_TEXT_SIZE_MIN || parsed > BODY_TEXT_SIZE_MAX) {
    return { value: null, error: '字号需在 12～24 之间。' }
  }
  return { value: parsed, error: null }
}

export function useAppearanceSettings(
  client: AppearanceSettingsClient,
  probe: FontAvailabilityProbe = probeLocalFontAvailability
): AppearanceFlow {
  const [loadState, setLoadState] = useState<AppearanceLoadState>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailure, setSaveFailure] = useState<AppearanceSaveFailure | null>(null)
  const [baseline, setBaseline] = useState<AppearanceValues>(DEFAULT_APPEARANCE_VALUES)
  const [draft, setDraft] = useState<AppearanceValues>(DEFAULT_APPEARANCE_VALUES)
  const [bodyTextInput, setBodyTextInput] = useState(String(DEFAULT_APPEARANCE_VALUES.bodyTextSize))
  const [bodyTextError, setBodyTextError] = useState<string | null>(null)
  const [fontPresets, setFontPresets] = useState<readonly FontPresetOptionVO[]>([])
  const [fontCheckTick, setFontCheckTick] = useState(0)

  const [fontProbe] = useState<FontAvailabilityProbe>(() => probe)
  const loadSeq = useRef(0)
  const baselineRef = useRef<AppearanceValues>(DEFAULT_APPEARANCE_VALUES)
  const fontPresetsRef = useRef<readonly FontPresetOptionVO[]>([])
  const dirtyRef = useRef(false)

  const applyCommitted = useCallback(
    (values: AppearanceValues, presets: readonly FontPresetOptionVO[]) => {
      baselineRef.current = values
      fontPresetsRef.current = presets
      setBaseline(values)
      setFontPresets(presets)
      setDraft(values)
      setBodyTextInput(String(values.bodyTextSize))
      setBodyTextError(null)
      setSaveFailure(null)
      applyAppearanceTokens(values, presets, undefined, fontProbe)
    },
    [fontProbe]
  )

  const load = useCallback(
    async (options?: { syncDraft?: boolean }): Promise<void> => {
      const seq = ++loadSeq.current
      setLoadState('loading')
      setLoadError(null)
      const result = await client.readAppearance()
      if (seq !== loadSeq.current) return
      if (result.code === ErrorCodes.success && result.data !== undefined) {
        clearLocalFontProbeCache()
        setFontCheckTick((tick) => tick + 1)
        const nextValues = pickAppearanceValues(result.data)
        const nextPresets = result.data.fontPresets
        if (options?.syncDraft === false && dirtyRef.current) {
          baselineRef.current = nextValues
          fontPresetsRef.current = nextPresets
          setBaseline(nextValues)
          setFontPresets(nextPresets)
          setLoadState('ready')
          return
        }
        applyCommitted(nextValues, nextPresets)
        setLoadState('ready')
        return
      }
      setLoadState('error')
      setLoadError('请检查设置是否被占用，然后重新读取。')
    },
    [applyCommitted, client]
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
      loadSeq.current += 1
    }
  }, [load])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => {
      if (baselineRef.current.reducedMotion === 'system') {
        applyAppearanceTokens(baselineRef.current, fontPresetsRef.current, undefined, fontProbe)
      }
    }
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [fontProbe])

  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) return
    let active = true
    void document.fonts.ready.then(() => {
      if (!active) return
      clearLocalFontProbeCache()
      setFontCheckTick((tick) => tick + 1)
      applyAppearanceTokens(baselineRef.current, fontPresetsRef.current, undefined, fontProbe)
    })
    return () => {
      active = false
    }
  }, [fontProbe])

  const dirty = useMemo(
    () => bodyTextError !== null || !isSameAppearanceValues(draft, baseline),
    [bodyTextError, draft, baseline]
  )

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const selectedFontAvailable = useMemo(() => {
    void fontCheckTick
    const preset = fontPresets.find((item) => item.id === draft.fontPresetId)
    return isSystemFontAvailable(preset, fontProbe)
  }, [draft.fontPresetId, fontCheckTick, fontPresets, fontProbe])

  const canSave = loadState === 'ready' && !saving && dirty && bodyTextError === null

  const setFontPresetId = useCallback((value: string): void => {
    setSaveFailure(null)
    setDraft((prev) => ({ ...prev, fontPresetId: value }))
  }, [])

  const setBodyTextFromSlider = useCallback((value: number): void => {
    const clamped = Math.min(BODY_TEXT_SIZE_MAX, Math.max(BODY_TEXT_SIZE_MIN, Math.round(value)))
    setSaveFailure(null)
    setBodyTextError(null)
    setBodyTextInput(String(clamped))
    setDraft((prev) => ({ ...prev, bodyTextSize: clamped }))
  }, [])

  const setBodyTextFromInput = useCallback((raw: string): void => {
    setSaveFailure(null)
    setBodyTextInput(raw)
    const parsed = validateBodyTextInput(raw)
    setBodyTextError(parsed.error)
    if (parsed.value !== null) {
      const value = parsed.value
      setDraft((prev) => ({ ...prev, bodyTextSize: value }))
    }
  }, [])

  const setGlassOpacity = useCallback((value: number): void => {
    const snapped = Math.round(value / GLASS_OPACITY_STEP) * GLASS_OPACITY_STEP
    const clamped = Math.min(GLASS_OPACITY_MAX, Math.max(GLASS_OPACITY_MIN, snapped))
    setSaveFailure(null)
    setDraft((prev) => ({ ...prev, glassOpacity: clamped }))
  }, [])

  const setHighContrast = useCallback((value: boolean): void => {
    setSaveFailure(null)
    setDraft((prev) => ({ ...prev, highContrast: value }))
  }, [])

  const setReducedMotion = useCallback((value: AppearanceValues['reducedMotion']): void => {
    setSaveFailure(null)
    setDraft((prev) => ({ ...prev, reducedMotion: value }))
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (saving || loadState !== 'ready' || bodyTextError !== null) return false
    setSaving(true)
    setSaveFailure(null)
    toast.dismiss(APPEARANCE_SAVE_TOAST_ID)
    toast.loading('正在保存外观…', {
      id: APPEARANCE_SAVE_TOAST_ID,
      duration: Infinity
    })
    const request: SaveAppearanceSettingsDTO = {
      fontPresetId: draft.fontPresetId,
      bodyTextSize: draft.bodyTextSize,
      glassOpacity: draft.glassOpacity,
      highContrast: draft.highContrast,
      reducedMotion: draft.reducedMotion,
      themePreset: draft.themePreset
    }
    const result = await client.saveAppearance(request)
    setSaving(false)
    if (result.code === ErrorCodes.success && result.data !== undefined) {
      const committed = pickAppearanceValues(result.data)
      applyCommitted(committed, result.data.fontPresets)
      toast.success('外观设置已保存', {
        id: APPEARANCE_SAVE_TOAST_ID,
        duration: 3200
      })
      return true
    }
    toast.dismiss(APPEARANCE_SAVE_TOAST_ID)
    const ambiguous = result.code === ErrorCodes.communicationFailed
    setSaveFailure({
      code: result.code,
      message: ambiguous
        ? '保存外观时通信中断，结果待确认；请先重新读取或重试保存。'
        : result.msg || '外观设置保存失败',
      ambiguous
    })
    return false
  }, [applyCommitted, bodyTextError, client, draft, loadState, saving])

  const dismissSaveFailure = useCallback((): void => {
    setSaveFailure(null)
  }, [])

  const discardChanges = useCallback((): void => {
    const committed = baselineRef.current
    setDraft(committed)
    setBodyTextInput(String(committed.bodyTextSize))
    setBodyTextError(null)
    setSaveFailure(null)
  }, [])

  const retryLoad = useCallback(async (): Promise<void> => {
    await load({ syncDraft: true })
  }, [load])

  const reloadAfterSaveConflict = useCallback(async (): Promise<void> => {
    setSaveFailure(null)
    await load({ syncDraft: true })
  }, [load])

  return {
    loadState,
    loadError,
    saving,
    saveFailure,
    draft,
    bodyTextInput,
    bodyTextError,
    fontPresets,
    selectedFontAvailable,
    dirty,
    canSave,
    load,
    retryLoad,
    reloadAfterSaveConflict,
    setFontPresetId,
    setBodyTextFromSlider,
    setBodyTextFromInput,
    setGlassOpacity,
    setHighContrast,
    setReducedMotion,
    save,
    dismissSaveFailure,
    discardChanges
  }
}
