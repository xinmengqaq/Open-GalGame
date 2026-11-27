import {
  GUIDE_STEP_ID,
  isGuideArrangeBeatId,
  isGuideStepId,
  type GuideArrangeBeatId,
  type GuideStepId
} from './guideSteps'

/** W2 的 e2e 前置会直接写这个 key，改动时必须同步测试和交接。 */
export const GUIDE_PREFERENCES_KEY = 'opengalgame.beginner-guide.v1'

export const GUIDE_PREFERENCES_VERSION = 1 as const

export type GuidePreferenceStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

/** 只保存本机阅读偏好和最后查看位置；不保存项目、路径、密钥、正文或滚动像素。 */
export type GuidePreferences = {
  version: typeof GUIDE_PREFERENCES_VERSION
  invitationHandled: boolean
  /**
   * 教程模式是否仍开启。退出或结束阅读后为 false，重启不再自动显示浮窗。
   * 旧版本偏好没有这个字段时按 false 读取，避免升级后突然弹出教程。
   */
  tutorialModeActive: boolean
  /** 原始字符串，可能是旧版本已删除的步骤 id，由 resolveGuideRestore 判定。 */
  lastStepId: string | null
  /** 上次查看的第 4 步编排拍；其他步骤或旧偏好为 null。 */
  lastBeatId: GuideArrangeBeatId | null
}

export type GuideRestoreSignal =
  | { kind: 'first-step' }
  | { kind: 'resume'; stepId: GuideStepId; beatId: GuideArrangeBeatId | null }
  | { kind: 'open-catalog'; staleStepId: string }

export function createDefaultGuidePreferences(): GuidePreferences {
  return {
    version: GUIDE_PREFERENCES_VERSION,
    invitationHandled: false,
    tutorialModeActive: false,
    lastStepId: null,
    lastBeatId: null
  }
}

/**
 * 读取并容错：缺失、损坏 JSON、错误版本或字段类型不符都回到默认值。
 * 读取不会自动打开邀请或教程，是否邀请由 shouldAutoInvite 决定。
 */
export function readGuidePreferences(
  storage: GuidePreferenceStorage | null | undefined = defaultGuideStorage()
): GuidePreferences {
  const target = storage ?? null
  if (!target) return createDefaultGuidePreferences()

  let raw: string | null
  try {
    raw = target.getItem(GUIDE_PREFERENCES_KEY)
  } catch {
    return createDefaultGuidePreferences()
  }
  if (raw === null) return createDefaultGuidePreferences()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return createDefaultGuidePreferences()
  }
  if (!isRecord(parsed)) return createDefaultGuidePreferences()
  if (parsed.version !== GUIDE_PREFERENCES_VERSION) return createDefaultGuidePreferences()

  const lastStepId = typeof parsed.lastStepId === 'string' ? parsed.lastStepId : null
  return {
    version: GUIDE_PREFERENCES_VERSION,
    invitationHandled: parsed.invitationHandled === true,
    tutorialModeActive: parsed.tutorialModeActive === true,
    lastStepId,
    lastBeatId:
      lastStepId === GUIDE_STEP_ID.arrangeScene && isGuideArrangeBeatId(parsed.lastBeatId)
        ? parsed.lastBeatId
        : null
  }
}

/**
 * 写入前清洗：只写固定步骤 id；未知 id 不落盘，避免下次恢复时猜步骤。
 * 返回是否真正写入（存储不可用或配额失败时为 false）。
 */
export function writeGuidePreferences(
  preferences: GuidePreferences,
  storage: GuidePreferenceStorage | null | undefined = defaultGuideStorage()
): boolean {
  const target = storage ?? null
  if (!target) return false

  const lastStepId =
    typeof preferences.lastStepId === 'string' && isGuideStepId(preferences.lastStepId)
      ? preferences.lastStepId
      : null
  const sanitized: GuidePreferences = {
    version: GUIDE_PREFERENCES_VERSION,
    invitationHandled: preferences.invitationHandled === true,
    tutorialModeActive: preferences.tutorialModeActive === true,
    lastStepId,
    lastBeatId:
      lastStepId === GUIDE_STEP_ID.arrangeScene && isGuideArrangeBeatId(preferences.lastBeatId)
        ? preferences.lastBeatId
        : null
  }

  try {
    target.setItem(GUIDE_PREFERENCES_KEY, JSON.stringify(sanitized))
    return true
  } catch {
    return false
  }
}

export function markGuideInvitationHandled(
  storage?: GuidePreferenceStorage | null
): GuidePreferences {
  const preferences = readGuidePreferences(storage)
  const next: GuidePreferences = {
    ...preferences,
    invitationHandled: true
  }
  writeGuidePreferences(next, storage)
  return next
}

export function recordGuideStepId(
  stepId: GuideStepId,
  storage?: GuidePreferenceStorage | null
): GuidePreferences {
  const preferences = readGuidePreferences(storage)
  const next: GuidePreferences = {
    ...preferences,
    lastStepId: stepId,
    lastBeatId: null
  }
  writeGuidePreferences(next, storage)
  return next
}

export function clearGuidePreferences(storage?: GuidePreferenceStorage | null): GuidePreferences {
  const target = storage ?? defaultGuideStorage()
  if (target?.removeItem) {
    try {
      target.removeItem(GUIDE_PREFERENCES_KEY)
    } catch {
      // 删除失败不影响当前窗口继续跟做。
    }
  }
  return createDefaultGuidePreferences()
}

/** 上次读到的步骤不存在时请求打开目录，不默默落到第一步。 */
export function resolveGuideRestore(preferences: GuidePreferences): GuideRestoreSignal {
  const stepId = preferences.lastStepId
  if (stepId === null) return { kind: 'first-step' }
  if (isGuideStepId(stepId)) {
    return {
      kind: 'resume',
      stepId,
      beatId: stepId === GUIDE_STEP_ID.arrangeScene ? preferences.lastBeatId : null
    }
  }
  return { kind: 'open-catalog', staleStepId: stepId }
}

/** 只有尚未处理过邀请时才允许自动邀请；读取偏好本身绝不弹窗。 */
export function shouldAutoInvite(preferences: GuidePreferences): boolean {
  return !preferences.invitationHandled
}

function defaultGuideStorage(): GuidePreferenceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
