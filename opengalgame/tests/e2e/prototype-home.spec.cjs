const { test, expect } = require('@playwright/test')
const path = require('node:path')

const importOk = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'prototypes',
  'home',
  'e2e',
  'fixtures',
  'import-ok'
)
const importFail = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'prototypes',
  'home',
  'e2e',
  'fixtures',
  'import-fail'
)

async function openHome(page) {
  await page.goto('index.html')
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeEnabled()
}

test('入场后三个入口可点', async ({ page }) => {
  await openHome(page)
  await expect(page.getByRole('link', { name: /项目选择/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建空白画布' })).toBeEnabled()
})

test('导入成功后显示结果卡', async ({ page }) => {
  await openHome(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入项目/ }).click()
  await (await chooserPromise).setFiles(importOk)
  await expect(page.getByRole('heading', { name: '导入项目' })).toBeVisible()
  await expect(page.getByText('项目已导入')).toBeVisible()
  await expect(page.getByRole('link', { name: '前往项目选择' })).toBeVisible()
})

test('导入取消不出现结果卡', async ({ page }) => {
  await openHome(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入项目/ }).click()
  await chooserPromise
  await page.locator('#directory-picker').evaluate((input) => {
    input.dispatchEvent(new Event('cancel', { bubbles: true }))
  })
  await expect(page.locator('#app-dialog')).not.toBeVisible()
  await expect(page.getByText('项目已导入')).toHaveCount(0)
})

test('导入失败显示错误卡', async ({ page }) => {
  await openHome(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /导入项目/ }).click()
  await (await chooserPromise).setFiles(importFail)
  await expect(page.getByText('导入未完成')).toBeVisible()
})

test('新建空名称显示字段错误', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '新建空白画布' }).click()
  await expect(page.getByRole('heading', { name: '新建项目' })).toBeVisible()
  await page.getByRole('button', { name: '创建项目' }).click()
  await expect(page.getByText('请填写项目名称')).toBeVisible()
  await expect(page.locator('#project-name')).toBeFocused()
})

test('连接测试失败就地显示', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.locator('#model-id').fill('fail-timeout')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByText('连接测试未通过')).toBeVisible()
  await expect(page.locator('#api-key')).toHaveValue('')
})

test('1280 与 1920 构图入口可见', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openHome(page)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeInViewport()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeInViewport()
  await expect(page.getByRole('img', { name: /魔女/ })).toBeVisible()
})
