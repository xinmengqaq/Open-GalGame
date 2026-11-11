const { test } = require('@playwright/test')
const path = require('node:path')

const out = path.join(__dirname, '..', '..', '..', 'output', 'playwright')

async function openProjects(page, search = '') {
  await page.goto(`/${search}`)
  await page.getByRole('button', { name: '项目选择' }).click()
  await page.getByRole('heading', { name: '项目' }).waitFor()
  await page.waitForTimeout(700)
}

test('截项目页各状态', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await page.getByRole('button', { name: /导入项目/ }).waitFor()
  await page.waitForTimeout(900)
  await page.screenshot({ path: path.join(out, 'home-1920.png'), fullPage: true })

  await page.getByRole('button', { name: '项目选择' }).click()
  await page.getByRole('heading', { name: '项目' }).waitFor()
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(out, 'projects-1920.png') })

  await page.getByTestId('project-card').first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(out, 'projects-1920-selected.png') })

  await page.getByRole('button', { name: '重命名' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(out, 'projects-1920-rename.png') })
  await page.getByRole('button', { name: '取消' }).click()

  await page.getByTestId('project-card').first().click({ button: 'right' })
  await page.getByRole('button', { name: '移出列表' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(out, 'projects-1920-remove.png') })
  await page.getByRole('button', { name: '留下' }).click()

  await page.getByRole('button', { name: '下一页' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(out, 'projects-1920-page2.png') })

  await page.setViewportSize({ width: 1440, height: 900 })
  await openProjects(page)
  await page.screenshot({ path: path.join(out, 'projects-1440.png') })

  await page.setViewportSize({ width: 1280, height: 720 })
  await openProjects(page)
  await page.screenshot({ path: path.join(out, 'projects-1280.png') })

  await page.setViewportSize({ width: 1920, height: 1080 })
  await openProjects(page, '?projects=empty')
  await page.screenshot({ path: path.join(out, 'projects-1920-empty.png') })

  await openProjects(page, '?projects=fail')
  await page.screenshot({ path: path.join(out, 'projects-1920-fail.png') })
})
