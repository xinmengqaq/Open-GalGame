import { describe, expect, it, vi } from 'vitest'
import {
  GUIDE_PREFERENCES_KEY,
  GUIDE_PREFERENCES_VERSION,
  clearGuidePreferences,
  createDefaultGuidePreferences,
  markGuideInvitationHandled,
  readGuidePreferences,
  recordGuideStepId,
  resolveGuideRestore,
  shouldAutoInvite,
  writeGuidePreferences,
  type GuidePreferenceStorage,
  type GuidePreferences
} from '@presentation/features/beginner-guide/guidePreferences'

class MemoryStorage implements GuidePreferenceStorage {
  readonly values = new Map<string, string>()
  writes = 0
  removals = 0

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes += 1
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.removals += 1
    this.values.delete(key)
  }
}

function stored(storage: MemoryStorage): Record<string, unknown> {
  const raw = storage.getItem(GUIDE_PREFERENCES_KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw as string) as Record<string, unknown>
}

describe('新手指引本机偏好', () => {
  it('key 带版本，只包含版本、邀请处理、教程模式和上次查看位置', () => {
    expect(GUIDE_PREFERENCES_KEY).toBe('opengalgame.beginner-guide.v1')
    expect(GUIDE_PREFERENCES_VERSION).toBe(1)
    expect(createDefaultGuidePreferences()).toEqual({
      version: 1,
      invitationHandled: false,
      tutorialModeActive: false,
      lastStepId: null,
      lastBeatId: null,
      entryHidden: false
    })

    const storage = new MemoryStorage()
    writeGuidePreferences(
      {
        version: 1,
        invitationHandled: true,
        tutorialModeActive: true,
        lastStepId: 'arrange-scene',
        lastBeatId: null,
        entryHidden: false
      },
      storage
    )
    expect(Object.keys(stored(storage)).sort()).toEqual([
      'entryHidden',
      'invitationHandled',
      'lastBeatId',
      'lastStepId',
      'tutorialModeActive',
      'version'
    ])
    expect(stored(storage)).toEqual({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: 'arrange-scene',
      lastBeatId: null,
      entryHidden: false
    })
  })

  it('缺失 key、损坏 JSON、旧版本和错误字段都回到默认值', () => {
    const missing = new MemoryStorage()
    expect(readGuidePreferences(missing)).toEqual(createDefaultGuidePreferences())

    const broken = new MemoryStorage()
    broken.setItem(GUIDE_PREFERENCES_KEY, '{ not-json')
    expect(readGuidePreferences(broken)).toEqual(createDefaultGuidePreferences())

    const oldVersion = new MemoryStorage()
    oldVersion.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({ version: 0, invitationHandled: true, lastStepId: 'arrange-scene' })
    )
    expect(readGuidePreferences(oldVersion)).toEqual(createDefaultGuidePreferences())

    const wrongTypes = new MemoryStorage()
    wrongTypes.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({ version: 1, invitationHandled: 'yes', lastStepId: 42 })
    )
    expect(readGuidePreferences(wrongTypes)).toEqual({
      version: 1,
      invitationHandled: false,
      tutorialModeActive: false,
      lastStepId: null,
      lastBeatId: null,
      entryHidden: false
    })

    const arrayValue = new MemoryStorage()
    arrayValue.setItem(GUIDE_PREFERENCES_KEY, '[]')
    expect(readGuidePreferences(arrayValue)).toEqual(createDefaultGuidePreferences())
  })

  it('读取有效偏好但不自动邀请', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        invitationHandled: true,
        lastStepId: 'playtest-candidate',
        projectId: 'must-not-be-read'
      })
    )

    const preferences = readGuidePreferences(storage)
    expect(preferences).toEqual({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: false,
      lastStepId: 'playtest-candidate',
      lastBeatId: null,
      entryHidden: false
    })
    expect(shouldAutoInvite(preferences)).toBe(false)
    storage.writes = 0
    readGuidePreferences(storage)
    expect(storage.writes).toBe(0)
  })

  it('显式 null 存储会禁用读取，不碰本机偏好', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({ version: 1, invitationHandled: true, lastStepId: 'arrange-scene' })
    )

    vi.stubGlobal('window', { localStorage: storage })
    try {
      expect(readGuidePreferences(null)).toEqual(createDefaultGuidePreferences())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('写入前清洗，只落固定步骤 id，未知 id 不猜测', () => {
    const storage = new MemoryStorage()
    const dirty = {
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: 'removed-step',
      projectId: 'must-not-be-written'
    } as unknown as GuidePreferences

    expect(writeGuidePreferences(dirty, storage)).toBe(true)
    expect(stored(storage)).toEqual({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: null,
      lastBeatId: null,
      entryHidden: false
    })
  })

  it('缺失或已删除的 lastStepId 请求打开目录，不落到第一步', () => {
    expect(resolveGuideRestore(createDefaultGuidePreferences())).toEqual({
      kind: 'first-step'
    })
    expect(
      resolveGuideRestore({
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: 'save-and-generate',
        lastBeatId: null,
        entryHidden: false
      })
    ).toEqual({ kind: 'resume', stepId: 'save-and-generate', beatId: null })
    expect(
      resolveGuideRestore({
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: 'removed-step',
        lastBeatId: null,
        entryHidden: false
      })
    ).toEqual({ kind: 'open-catalog', staleStepId: 'removed-step' })
  })

  it('只有未处理过邀请时才允许自动邀请', () => {
    expect(shouldAutoInvite(createDefaultGuidePreferences())).toBe(true)
    expect(
      shouldAutoInvite({
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: null,
        lastBeatId: null,
        entryHidden: false
      })
    ).toBe(false)
  })

  it('标记邀请已处理、记录步骤和清理都只改本机偏好', () => {
    const storage = new MemoryStorage()
    const handled = markGuideInvitationHandled(storage)
    expect(handled.invitationHandled).toBe(true)
    expect(readGuidePreferences(storage).invitationHandled).toBe(true)

    const recorded = recordGuideStepId('export-build', storage)
    expect(recorded.lastStepId).toBe('export-build')
    expect(recorded.lastBeatId).toBeNull()
    expect(readGuidePreferences(storage).lastStepId).toBe('export-build')

    const cleared = clearGuidePreferences(storage)
    expect(cleared).toEqual(createDefaultGuidePreferences())
    expect(storage.removals).toBe(1)
    expect(readGuidePreferences(storage)).toEqual(createDefaultGuidePreferences())
  })

  it('第 4 步编排拍随步骤保存，其他步骤和非法拍不保留拍号', () => {
    const storage = new MemoryStorage()
    writeGuidePreferences(
      {
        version: 1,
        invitationHandled: true,
        tutorialModeActive: true,
        lastStepId: 'arrange-scene',
        lastBeatId: 'cue',
        entryHidden: false
      },
      storage
    )
    expect(readGuidePreferences(storage)).toEqual({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: 'arrange-scene',
      lastBeatId: 'cue',
      entryHidden: false
    })
    expect(resolveGuideRestore(readGuidePreferences(storage))).toEqual({
      kind: 'resume',
      stepId: 'arrange-scene',
      beatId: 'cue'
    })

    writeGuidePreferences(
      {
        version: 1,
        invitationHandled: true,
        tutorialModeActive: false,
        lastStepId: 'save-and-generate',
        lastBeatId: 'cue',
        entryHidden: false
      },
      storage
    )
    expect(stored(storage).lastBeatId).toBeNull()

    const bogus = new MemoryStorage()
    bogus.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        invitationHandled: true,
        lastStepId: 'arrange-scene',
        lastBeatId: 'not-a-beat'
      })
    )
    expect(readGuidePreferences(bogus).lastBeatId).toBeNull()
  })

  it('存储不可用时仍返回内存中的偏好，不抛错', () => {
    const broken: GuidePreferenceStorage = {
      getItem() {
        throw new Error('storage unavailable')
      },
      setItem() {
        throw new Error('storage unavailable')
      },
      removeItem() {
        throw new Error('storage unavailable')
      }
    }

    expect(readGuidePreferences(broken)).toEqual(createDefaultGuidePreferences())
    expect(writeGuidePreferences(createDefaultGuidePreferences(), broken)).toBe(false)
    expect(markGuideInvitationHandled(broken).invitationHandled).toBe(true)
    expect(recordGuideStepId('polish-dialogue', broken).lastStepId).toBe('polish-dialogue')
    expect(clearGuidePreferences(broken)).toEqual(createDefaultGuidePreferences())

    const noStorage = writeGuidePreferences(createDefaultGuidePreferences(), null)
    expect(noStorage).toBe(false)
    expect(readGuidePreferences(null)).toEqual(createDefaultGuidePreferences())
  })
})
