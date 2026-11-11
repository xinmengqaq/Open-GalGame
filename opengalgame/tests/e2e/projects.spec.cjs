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

async function openProjects(page, search = '') {
  await page.goto(`/${search}`)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
}

test('从首页进入项目页并可返回', async ({ page }) => {
  await openProjects(page)
  await page.getByRole('button', { name: '返回' }).click()
  await expect(page.getByRole('button', { name: '项目选择' })).toBeVisible()
})

test('默认两页：首页九张作品卡加新建卡，可翻页', async ({ page }) => {
  await openProjects(page)
  await expect(page.getByTestId('project-card')).toHaveCount(9)
  await expect(page.getByTestId('new-project-card')).toBeVisible()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByTestId('project-card')).toHaveCount(2)
  await expect(page.getByText('第 2 页')).toBeVisible()
})

test('单击可用卡直接进入工作区', async ({ page }) => {
  await openProjects(page)
  await expect(page.getByRole('button', { name: '重命名', exact: true })).toHaveCount(0)
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await expect(page.getByText('未寄出的第二封信')).toBeVisible()
})

test('右键显示竖向编辑菜单，Esc 和点击空白关闭', async ({ page }) => {
  await openProjects(page)
  const first = page.getByTestId('project-card').first()
  await first.click({ button: 'right' })
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  const rename = page.getByRole('button', { name: '重命名', exact: true })
  const remove = page.getByRole('button', { name: '移出列表', exact: true })
  const renameBox = await rename.boundingBox()
  const removeBox = await remove.boundingBox()
  expect(removeBox.y).toBeGreaterThanOrEqual(renameBox.y + renameBox.height)
  expect(removeBox.x).toBe(renameBox.x)
  await page.keyboard.press('Escape')
  await expect(rename).toHaveCount(0)
  await first.click({ button: 'right' })
  await page.getByRole('heading', { name: '项目' }).click()
  await expect(rename).toHaveCount(0)
})

test('切换卡片右键菜单后仍可关闭并重新打开', async ({ page }) => {
  await openProjects(page)
  const cards = page.getByTestId('project-card')
  await cards.nth(0).click({ button: 'right' })
  await cards.nth(1).click({ button: 'right' })
  await expect(page.getByRole('group', { name: '项目编辑操作' })).toHaveCount(1)
  await cards.nth(0).click({ button: 'right' })
  await expect(page.getByRole('group', { name: '项目编辑操作' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('group', { name: '项目编辑操作' })).toHaveCount(0)
})

test('单击不可用卡留在项目页，右键可以移出', async ({ page }) => {
  await openProjects(page)
  await page.getByRole('button', { name: '下一页' }).click()
  const unavailable = page.getByRole('button', { name: '无法读取的项目' })
  await unavailable.click()
  await expect(page.getByRole('button', { name: '移出列表', exact: true })).toHaveCount(0)
  await unavailable.click({ button: 'right' })
  await expect(page.getByRole('button', { name: '移出列表', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重命名', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '工作区' })).toHaveCount(0)
})

test('右键重命名后标题变化，编辑菜单保持关闭', async ({ page }) => {
  await openProjects(page)
  await page.getByTestId('project-card').first().click({ button: 'right' })
  await page.getByRole('button', { name: '重命名' }).click()
  await page.locator('#rename-project-name').fill('改过的信')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('button', { name: /改过的信/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '重命名', exact: true })).toHaveCount(0)
})

test('移出确认后卡片消失', async ({ page }) => {
  await openProjects(page)
  const first = page.getByTestId('project-card').first()
  const name = await first.innerText()
  await first.click({ button: 'right' })
  await page.getByRole('button', { name: '移出列表' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移出列表' }).click()
  await expect(page.getByRole('button', { name: name.split('\n')[0] })).toHaveCount(0)
})

test('空列表提示并保留新建', async ({ page }) => {
  await openProjects(page, '?projects=empty')
  await expect(page.getByText('还没有作品')).toBeVisible()
  await expect(page.getByTestId('new-project-card')).toBeVisible()
  await expect(page.getByRole('button', { name: '导入' })).toBeEnabled()
})

test('列表失败可重试，不装成空列表', async ({ page }) => {
  await openProjects(page, '?projects=fail')
  await expect(page.getByText('项目列表加载失败，请重试')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  await expect(page.getByText('还没有作品')).toHaveCount(0)
})

test('本页导入成功返回列表', async ({ page }) => {
  await openProjects(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入' }).click()
  await (await chooserPromise).setFiles(importOk)
  await expect(page.getByText('项目已导入')).toBeVisible()
  await page.getByRole('button', { name: '返回列表' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
})

test('1280 宽顶栏操作仍可见', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openProjects(page)
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一页' })).toBeVisible()
})
