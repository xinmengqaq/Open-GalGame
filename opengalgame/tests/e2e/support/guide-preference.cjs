'use strict'

/**
 * 与 src/presentation/features/beginner-guide/guidePreferences.ts 保持一致。
 * 教程偏好只影响外观，不进项目数据；换了 key 或版本必须同步这里。
 */
const GUIDE_PREFERENCES_KEY = 'opengalgame.beginner-guide.v1'
const GUIDE_PREFERENCES_VERSION = 1

const HANDLED_PREFERENCE = {
  version: GUIDE_PREFERENCES_VERSION,
  invitationHandled: true,
  tutorialModeActive: false,
  lastStepId: null,
  lastBeatId: null
}

const seededPages = new WeakSet()

/**
 * 把「邀请已处理」预写进版本化偏好，避免首次邀请弹窗挡住现有的首页入口用例。
 * 必须在同一个 page 第一次 page.goto 之前调用；之后同 page 的导航会自动带上。
 */
async function seedGuidePreference(page) {
  if (seededPages.has(page)) return
  seededPages.add(page)
  await page.addInitScript(
    (preference) => {
      try {
        window.localStorage.setItem(preference.key, JSON.stringify(preference.value))
      } catch {
        // 存储不可用时保持默认偏好：邀请弹窗会挡住入口，用例失败时会直接暴露。
      }
    },
    { key: GUIDE_PREFERENCES_KEY, value: HANDLED_PREFERENCE }
  )
}

module.exports = {
  GUIDE_PREFERENCES_KEY,
  GUIDE_PREFERENCES_VERSION,
  seedGuidePreference
}
