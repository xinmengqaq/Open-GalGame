'use strict'

const { expect } = require('@playwright/test')

/**
 * 首页唯一「设置」入口与设置中心分区的可复用浏览器契约。
 * 只使用用户可见角色/标签与结果：入口按钮「设置」、对话框「设置」、分区标签名称。
 */
const SETTINGS_ENTRY = '设置'
const SETTINGS_DIALOG = '设置'
const APPEARANCE_SECTION = '外观与舒适度'
const CONNECTION_SECTION = '模型连接'
const GUIDE_UPDATE_SECTION = '新手引导与更新'
const DISCARD_DIALOG = '放弃未保存的更改？'

function settingsEntry(page) {
  return page.getByRole('button', { name: SETTINGS_ENTRY, exact: true })
}

function settingsDialog(page) {
  return page.getByRole('dialog', { name: SETTINGS_DIALOG })
}

function discardConfirmDialog(page) {
  return page.getByRole('dialog', { name: DISCARD_DIALOG })
}

/** 从首页唯一「设置」入口打开设置中心。 */
async function openSettings(page) {
  await settingsEntry(page).click()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  return dialog
}

/** 按分区标签切换；已选中时不重复点击，避免无谓的草稿确认。 */
async function selectSettingsSection(page, label) {
  const tab = page.getByRole('tab', { name: label })
  await expect(tab).toBeVisible()
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
  }
  const panelId = await tab.getAttribute('aria-controls')
  if (panelId) {
    await expect(page.locator(`#${panelId}`)).toBeVisible()
  }
  return tab
}

/** 打开设置中心并切到「模型连接」；不假定初始分区（取决于是否已配置模型）。 */
async function openConnectionSettings(page) {
  const dialog = await openSettings(page)
  await selectSettingsSection(page, CONNECTION_SECTION)
  return dialog
}

/** 无脏草稿时用页脚「关闭」退出设置中心。 */
async function closeSettings(page) {
  const dialog = settingsDialog(page)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** 在「放弃未保存的更改？」确认框里选择指定动作并等待关闭。 */
async function answerDiscardConfirm(page, label) {
  const confirm = discardConfirmDialog(page)
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: label, exact: true }).click()
  await expect(confirm).toBeHidden()
}

module.exports = {
  SETTINGS_ENTRY,
  SETTINGS_DIALOG,
  APPEARANCE_SECTION,
  CONNECTION_SECTION,
  GUIDE_UPDATE_SECTION,
  DISCARD_DIALOG,
  settingsEntry,
  settingsDialog,
  discardConfirmDialog,
  openSettings,
  selectSettingsSection,
  openConnectionSettings,
  closeSettings,
  answerDiscardConfirm
}
