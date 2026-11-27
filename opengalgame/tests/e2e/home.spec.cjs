const { test, expect } = require('@playwright/test')
const path = require('node:path')

const { seedGuidePreference } = require('./support/guide-preference.cjs')
const {
  openConnectionSettings,
  openSettings,
  selectSettingsSection,
  settingsEntry,
  APPEARANCE_SECTION
} = require('./support/settings-center.cjs')

const fixtures = path.join(__dirname, 'fixtures')
const importOk = path.join(fixtures, 'import-ok')
const importFail = path.join(fixtures, 'import-fail')
const createOk = path.join(fixtures, 'import-ok')

async function openHome(page) {
  await seedGuidePreference(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 10000 })
}

async function homeLayout(page) {
  return page.evaluate(() => {
    const home = document.querySelector('section[aria-label="首页"]')
    const rectOf = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return { x, y, width, height }
    }
    return {
      home: rectOf(home),
      header: rectOf(home.querySelector('header')),
      stage: rectOf(home.querySelector('main')),
      footer: rectOf(home.querySelector('footer')),
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight
    }
  })
}

test('入场后入口可点', async ({ page }) => {
  await openHome(page)
  await expect(page.getByRole('button', { name: '新建空白画布' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '项目选择' })).toBeEnabled()
})

test('导入成功后可去项目页', async ({ page }) => {
  await openHome(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入项目/ }).click()
  await (await chooserPromise).setFiles(importOk)
  await expect(page.getByText('项目已导入')).toBeVisible()
  await page.getByRole('button', { name: '前往项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
})

test('导入取消留在首页', async ({ page }) => {
  await openHome(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入项目/ }).click()
  await chooserPromise
  await page.locator('[data-testid="directory-picker"]').evaluate((input) => {
    input.dispatchEvent(new Event('cancel', { bubbles: true }))
  })
  await expect(page.getByText('项目已导入')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible()
})

test('导入失败显示错误卡', async ({ page }) => {
  await openHome(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入项目/ }).click()
  await (await chooserPromise).setFiles(importFail)
  await expect(page.getByText('导入未完成', { exact: true })).toBeVisible()
})

test('新建空名称显示字段错误', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '新建空白画布' }).click()
  await page.getByRole('button', { name: '创建项目' }).click()
  await expect(page.getByText('请填写项目名称')).toBeVisible()
  await expect(page.locator('#project-name')).toBeFocused()
})

test('新建未选保存位置显示字段错误', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '新建空白画布' }).click()
  await page.locator('#project-name').fill('月光工坊')
  await page.getByRole('button', { name: '创建项目' }).click()
  await expect(page.getByText('请选择保存位置')).toBeVisible()
})

test('新建成功进入工作区并提示', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '新建空白画布' }).click()
  await page.locator('#project-name').fill('月光工坊')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择文件夹' }).click()
  await (await chooserPromise).setFiles(createOk)
  await expect(page.locator('#project-save-location')).not.toHaveValue('')
  await page.getByRole('button', { name: '创建项目' }).click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await expect(page.getByText('项目已创建')).toBeVisible()
})

test('设置中心模型连接协议用统一下拉选择', async ({ page }) => {
  await openHome(page)
  const settings = await openConnectionSettings(page)
  const protocol = settings.locator('#provider-id')
  await protocol.click()
  await page.getByRole('option', { name: 'Anthropic' }).click()
  await expect(protocol).toHaveText('Anthropic')
})

test('连接测试失败在应用右上角通知显示安全分类且可关闭', async ({ page }) => {
  await openHome(page)
  const settings = await openConnectionSettings(page)
  await page.locator('#model-id').fill('fail-timeout')
  await page.getByRole('button', { name: '测试连接' }).click()
  const toast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('连接测试未通过')
  await expect(toast).toContainText('请求超时')
  await expect(toast).toContainText('检查上游地址和网络后重新测试。')
  await expect.poll(async () => (await toast.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0)
  const toastBox = await toast.boundingBox()
  const titleBox = await settings.getByRole('heading', { name: '设置', exact: true }).boundingBox()
  const viewport = page.viewportSize()
  expect(toastBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  if (toastBox && titleBox && viewport) {
    // 提示是悬浮反馈：留在视口右上角，不遮挡设置标题，也不参与表单布局。
    expect(toastBox.x).toBeGreaterThanOrEqual(viewport.width / 2)
    expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(viewport.width)
    expect(toastBox.y).toBeGreaterThanOrEqual(0)
    expect(toastBox.y).toBeLessThan(viewport.height / 2)
    const overlapsTitle =
      toastBox.x < titleBox.x + titleBox.width &&
      toastBox.x + toastBox.width > titleBox.x &&
      toastBox.y < titleBox.y + titleBox.height &&
      toastBox.y + toastBox.height > titleBox.y
    expect(overlapsTitle).toBe(false)
  }
  await expect(toast.getByRole('button', { name: '关闭通知' })).toBeVisible()
  await expect(settings.getByText('上次操作')).toHaveCount(0)
  // 帮助按钮也带 data-tone=neutral；只按连接分区内可见的失败状态文案断言。
  const connectionPanel = settings.locator('#settings-panel-connection')
  await expect(connectionPanel.getByText('连接测试未通过')).toHaveCount(0)
  await expect(connectionPanel.getByText('请求超时')).toHaveCount(0)
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0)
  await toast.getByRole('button', { name: '关闭通知' }).click()
  await expect(toast).toHaveCount(0)
  await expect(page.getByRole('button', { name: '测试连接' })).toBeEnabled()
})

test('拉取上游模型列表后用统一下拉填入模型', async ({ page }) => {
  await openHome(page)
  await openConnectionSettings(page)
  await page.locator('#base-url').fill('http://127.0.0.1:8080/v1')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText(
    '已拉取 2 个模型'
  )
  await expect(page.locator('#model-id')).toHaveAttribute('role', 'combobox')
  await page.locator('#model-id').click()
  const listbox = page.getByRole('listbox')
  await expect(listbox.getByRole('option')).toHaveCount(2)
  await listbox.getByRole('option', { name: 'demo-chat', exact: true }).click()
  await expect(page.locator('#model-id')).toHaveText('demo-chat')
})

test('拉取模型列表失败就地显示', async ({ page }) => {
  await openHome(page)
  await openConnectionSettings(page)
  await page.locator('#base-url').fill('http://127.0.0.1:8080/fail')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '拉取列表' }).click()
  const toast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(toast).toContainText('无法拉取模型列表')
  await expect(toast).toContainText('无法连接模型服务')
  await expect(page.locator('#model-id')).toHaveRole('textbox')
  await expect(page.getByRole('option')).toHaveCount(0)
})

test('保存成功保留设置中心并单次悬浮通知后自动消失', async ({ page }) => {
  await openHome(page)
  const settings = await openConnectionSettings(page)
  await page.locator('#base-url').fill('http://127.0.0.1:8080/v1')
  await page.locator('#model-id').fill('demo')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  // 设置中心是唯一设置入口：保存连接不再关闭整个中心，仍停在模型连接区。
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('tab', { name: '模型连接' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  const notifications = page.getByRole('region', { name: /Notifications/ })
  const successToasts = notifications.locator('[data-sonner-toast][data-type="success"]')
  await expect(successToasts).toHaveCount(1)
  await expect(successToasts).toBeVisible()
  await expect(page.locator('[data-sonner-toaster]')).toHaveCSS('position', 'fixed')

  const layoutWithToast = await homeLayout(page)
  const fieldWithToast = await page.locator('#base-url').boundingBox()
  await page.mouse.move(0, 0)
  const toastHasFocus = await page.evaluate(() => {
    const toast = document.querySelector('[data-sonner-toast]')
    return toast !== null && toast.contains(document.activeElement)
  })
  expect(toastHasFocus).toBe(false)
  await expect(successToasts).toHaveCount(0)
  expect(await homeLayout(page)).toEqual(layoutWithToast)
  // 纯反馈悬浮层不占布局，正在编辑的表单位置不因提示出现/消失而移动。
  expect(await page.locator('#base-url').boundingBox()).toEqual(fieldWithToast)

  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()
  await openConnectionSettings(page)
  await expect(page.locator('#base-url')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await expect(notifications.locator('[data-sonner-toast]')).toHaveCount(0)
})

test('首页只有设置入口，分区切换后关闭回到设置', async ({ page }) => {
  await openHome(page)
  await expect(page.getByRole('button', { name: /连接设置|应用设置/ })).toHaveCount(0)
  await expect(settingsEntry(page)).toBeVisible()
  const settings = await openSettings(page)
  await expect(settings.getByRole('tab', { name: '外观与舒适度' })).toBeVisible()
  await expect(settings.getByRole('tab', { name: '模型连接' })).toBeVisible()
  await expect(settings.getByRole('tab', { name: '新手引导与更新' })).toBeVisible()
  await selectSettingsSection(page, APPEARANCE_SECTION)
  await expect(settings.getByRole('tabpanel')).toBeVisible()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(settingsEntry(page)).toBeFocused()
})

test('设置中心未保存草稿关闭确认默认焦点在继续编辑', async ({ page }) => {
  await openHome(page)
  const settings = await openConnectionSettings(page)
  await page.locator('#base-url').fill('https://draft.example/v1')
  await page.keyboard.press('Escape')
  const discard = page.getByRole('dialog', { name: '放弃未保存的更改？' })
  await expect(discard).toBeVisible()
  await expect(discard.getByRole('button', { name: '继续编辑' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(discard).toBeHidden()
  await expect(settings).toBeVisible()
  await expect(page.locator('#base-url')).toHaveValue('https://draft.example/v1')
})

test('1280 入口不被裁切', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openHome(page)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeInViewport()
})
