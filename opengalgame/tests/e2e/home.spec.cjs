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
const createOk = path.join(
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

async function openHome(page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 10000 })
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
  await page.locator('#model-id').fill('fail-timeout')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByText('连接测试未通过')).toBeVisible()
  await expect(page.getByText('设置已保存')).toHaveCount(0)
})

test('拉取上游模型列表后用统一下拉填入模型', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.locator('#base-url').fill('http://127.0.0.1:8080/v1')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(page.getByText('已拉取 2 个模型')).toBeVisible()
  await page.locator('#model-id').click()
  await page.getByRole('option', { name: 'demo-chat' }).click()
  await expect(page.locator('#model-id')).toHaveText('demo-chat')
})

test('拉取模型列表失败就地显示', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.locator('#base-url').fill('http://127.0.0.1:8080/fail')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(page.getByText('无法拉取模型列表')).toBeVisible()
})

test('保存成功只在弹窗内提示', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.locator('#base-url').fill('http://127.0.0.1:8080/v1')
  await page.locator('#model-id').fill('demo')
  await page.locator('#api-key').fill('sk-demo')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('设置已保存')).toBeVisible()
  await expect(page.locator('[aria-live="polite"]')).not.toContainText('设置已保存')
})

test('1280 入口不被裁切', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openHome(page)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeInViewport()
})
