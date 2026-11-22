const { test, expect } = require('@playwright/test')
const path = require('node:path')

const fixtures = path.join(__dirname, 'fixtures')
const importOk = path.join(fixtures, 'import-ok')
const importFail = path.join(fixtures, 'import-fail')
const createOk = path.join(fixtures, 'import-ok')

async function openHome(page) {
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

test('连接协议用统一下拉选择', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Anthropic' }).click()
  await expect(page.getByRole('combobox')).toHaveText('Anthropic')
})

test('连接测试失败就地显示且不重复 Toast', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  const settings = page.getByRole('dialog', { name: '连接设置' })
  await page.locator('#model-id').fill('fail-timeout')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(settings.locator('[data-tone="error"]')).toBeVisible()
  await expect(settings.locator('[data-tone="success"]')).toHaveCount(0)
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '测试连接' })).toBeEnabled()
})

test('拉取上游模型列表后用统一下拉填入模型', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  const settings = page.getByRole('dialog', { name: '连接设置' })
  await page.locator('#base-url').fill('http://127.0.0.1:8080/v1')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(settings.locator('[data-tone="success"]')).toBeVisible()
  await expect(page.locator('#model-id')).toHaveAttribute('role', 'combobox')
  await page.locator('#model-id').click()
  const listbox = page.getByRole('listbox')
  await expect(listbox.getByRole('option')).toHaveCount(2)
  await listbox.getByRole('option', { name: 'demo-chat', exact: true }).click()
  await expect(page.locator('#model-id')).toHaveText('demo-chat')
})

test('拉取模型列表失败就地显示', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  const settings = page.getByRole('dialog', { name: '连接设置' })
  await page.locator('#base-url').fill('http://127.0.0.1:8080/fail')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(settings.locator('[data-tone="error"]')).toBeVisible()
  await expect(page.locator('#model-id')).toHaveRole('textbox')
  await expect(page.getByRole('option')).toHaveCount(0)
})

test('保存成功关闭弹窗并单次悬浮通知后自动消失', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  const settings = page.getByRole('dialog', { name: '连接设置' })
  await page.locator('#base-url').fill('http://127.0.0.1:8080/v1')
  await page.locator('#model-id').fill('demo')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(settings).toBeHidden()

  const notifications = page.getByRole('region', { name: /Notifications/ })
  const successToasts = notifications.locator('[data-sonner-toast][data-type="success"]')
  await expect(successToasts).toHaveCount(1)
  await expect(successToasts).toBeVisible()
  await expect(page.locator('[data-sonner-toaster]')).toHaveCSS('position', 'fixed')

  const layoutWithToast = await homeLayout(page)
  await page.mouse.move(0, 0)
  const toastHasFocus = await page.evaluate(() => {
    const toast = document.querySelector('[data-sonner-toast]')
    return toast !== null && toast.contains(document.activeElement)
  })
  expect(toastHasFocus).toBe(false)
  await expect(successToasts).toHaveCount(0)
  expect(await homeLayout(page)).toEqual(layoutWithToast)

  await page.getByRole('button', { name: '连接设置' }).click()
  await expect(settings).toBeVisible()
  await expect(page.locator('#base-url')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await expect(notifications.locator('[data-sonner-toast]')).toHaveCount(0)
})

test('1280 入口不被裁切', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openHome(page)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeInViewport()
})
