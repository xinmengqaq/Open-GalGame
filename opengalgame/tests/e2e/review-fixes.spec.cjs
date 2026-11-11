const { test, expect } = require('@playwright/test')
const path = require('node:path')

const fixtureFolder = path.join(__dirname)
const evidenceRoot = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'harness',
  'handoffs',
  'evidence',
  '2026-10-23-review-fixes',
  'ui'
)

async function pickFolder(page, label = '选择文件夹') {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: label }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixtureFolder)
}

async function openProjects(page) {
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
}

async function openWorkbench(page, search = '') {
  await page.goto(`/${search}`)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 10000 })
  await openProjects(page)
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
}

/** 等目标、祖先和入场动画节点落定，避免截图停在页面/卡片入场中间。 */
async function waitForSettled(page, selector) {
  await expect
    .poll(
      () =>
        page.evaluate((sel) => {
          const target = document.querySelector(sel)
          if (!(target instanceof HTMLElement)) return 'missing'
          const nodes = new Set([target])
          let ancestor = target.parentElement
          while (ancestor) {
            nodes.add(ancestor)
            ancestor = ancestor.parentElement
          }
          for (const animated of target.querySelectorAll('[data-motion], [data-card-enter]'))
            nodes.add(animated)
          let moving = 0
          for (const item of nodes) {
            if (!(item instanceof HTMLElement)) continue
            // 缺失光点按设计循环呼吸，不属于入场位移，截图允许其停在任一相位。
            if (item.matches('[data-motion="missing"]')) continue
            const style = getComputedStyle(item)
            if (Number(style.opacity) < 0.995) moving += 1
            if (style.transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(style.transform))
              moving += 1
          }
          return moving === 0 ? 'settled' : moving
        }, selector),
      { timeout: 5000 }
    )
    .toBe('settled')
}

/** 测量反馈浮层与弹窗标题、首个输入框的几何关系。 */
async function feedbackPlacement(page) {
  return page.evaluate(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1)
    const shelf = document.querySelector('[data-testid="workbench-feedback"]')
    if (!(dialog instanceof HTMLElement) || !(shelf instanceof HTMLElement)) return null
    const title = dialog.querySelector('h2')
    const input = dialog.querySelector('input, textarea')
    const footer = dialog.querySelector('footer')
    const rect = shelf.getBoundingClientRect()
    const overlaps = (other) => {
      if (!(other instanceof HTMLElement)) return false
      const box = other.getBoundingClientRect()
      return !(
        rect.right <= box.left ||
        box.right <= rect.left ||
        rect.bottom <= box.top ||
        box.bottom <= rect.top
      )
    }
    return {
      insideDialog: shelf.closest('dialog') === dialog,
      position: getComputedStyle(shelf).position,
      open: shelf.dataset.open,
      width: Math.round(rect.width),
      overlapsTitle: overlaps(title),
      overlapsInput: overlaps(input),
      aboveFooter:
        footer instanceof HTMLElement
          ? rect.bottom <= footer.getBoundingClientRect().top + 0.5
          : true
    }
  })
}

async function expectFeedbackBand(page) {
  const feedback = page.getByTestId('workbench-feedback')
  await expect(feedback).toHaveAttribute('data-host', 'dialog')
  await expect(feedback).toHaveAttribute('data-open', 'true')
  await expect
    .poll(() => feedbackPlacement(page))
    .toEqual({
      insideDialog: true,
      position: 'static',
      open: 'true',
      width: expect.any(Number),
      overlapsTitle: false,
      overlapsInput: false,
      aboveFooter: true
    })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 }
]) {
  const size = `${viewport.width}x${viewport.height}`

  test.describe(`${size}`, () => {
    test.use({ viewport })

    test('创建 1309 只给重新构建，带身份时直接打开工程', async ({ page }) => {
      await page.goto('/?homeFailure=create-with-id')
      await expect(page.getByRole('button', { name: /新建空白画布/ })).toBeVisible()
      await page.getByRole('button', { name: /新建空白画布/ }).click()
      await page.locator('#project-name').fill('雨夜待重建')
      await pickFolder(page)
      await page.getByRole('button', { name: '创建项目' }).click()

      const dialog = page.locator('dialog[open]')
      await expect(dialog.getByText('工程初始化未完成', { exact: true })).toBeVisible()
      await expect(dialog.getByText('重新构建会补齐缺失内容，不会删除已有作品。')).toBeVisible()
      await expect(dialog).not.toContainText('D:/secret')
      await expect(dialog).not.toContainText('.git')
      await expect(dialog.getByRole('button', { name: '创建项目' })).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '取消' })).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '重试登记' })).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '重新构建' })).toHaveCount(1)
      await page.screenshot({
        path: path.join(evidenceRoot, `01-create-1309-${size}.png`)
      })

      await dialog.getByRole('button', { name: '重新构建' }).click()
      await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
      await expect(page.locator('dialog[open]')).toHaveCount(0)
    })

    test('创建 1309 无身份时刷新列表，由工作台面板承接重建', async ({ page }) => {
      await page.goto('/?projects=empty&homeFailure=create-without-id&workspace=not-ready')
      await expect(page.getByRole('button', { name: /新建空白画布/ })).toBeVisible()
      await page.getByRole('button', { name: /新建空白画布/ }).click()
      await page.locator('#project-name').fill('站台待重建')
      await pickFolder(page)
      await page.getByRole('button', { name: '创建项目' }).click()

      const dialog = page.locator('dialog[open]')
      await expect(dialog.getByText('工程初始化未完成', { exact: true })).toBeVisible()
      await expect(dialog).not.toContainText('D:/secret')
      await expect(dialog.getByRole('button', { name: '重新构建' })).toHaveCount(1)
      await dialog.getByRole('button', { name: '重新构建' }).click()

      await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
      const card = page.getByTestId('project-card').filter({ hasText: '站台待重建' })
      await expect(card).toBeVisible()
      await waitForSettled(page, '[data-testid="project-card"]')
      await page.screenshot({
        path: path.join(evidenceRoot, `02-create-handoff-list-${size}.png`)
      })

      await card.click()
      const panel = page.getByTestId('workspace-not-ready')
      await expect(panel).toBeVisible()
      await expect(panel.getByRole('button', { name: '重新构建' })).toBeVisible()
      await waitForSettled(page, '[data-testid="workspace-not-ready"]')
      await page.screenshot({
        path: path.join(evidenceRoot, `03-workbench-not-ready-${size}.png`)
      })
      await panel.getByRole('button', { name: '重新构建' }).click()
      await expect(panel).toHaveCount(0)
      await expect(page.getByTestId('scene-canvas')).toBeVisible()
    })

    test('创建 1309 关闭弹窗后新工程仍在列表可见可打开', async ({ page }) => {
      await page.goto('/?projects=empty&homeFailure=create-without-id')
      await expect(page.getByRole('button', { name: /新建空白画布/ })).toBeVisible()
      await page.getByRole('button', { name: /新建空白画布/ }).click()
      await page.locator('#project-name').fill('信封待重建')
      await pickFolder(page)
      await page.getByRole('button', { name: '创建项目' }).click()

      const dialog = page.locator('dialog[open]')
      await expect(dialog.getByText('工程初始化未完成', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '关闭弹窗' }).click()
      await expect(dialog).toHaveCount(0)

      await openProjects(page)
      const card = page.getByTestId('project-card').filter({ hasText: '信封待重建' })
      await expect(card).toBeVisible()
      await waitForSettled(page, '[data-testid="project-card"]')
      await page.screenshot({
        path: path.join(evidenceRoot, `10-create-closed-list-${size}.png`)
      })
      await card.click()
      await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
    })

    test('导入 1309 只给重新构建，关闭后工程在列表可打开', async ({ page }) => {
      await page.goto('/?projects=empty&homeFailure=import')
      await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible()
      const chooserPromise = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: /导入项目/ }).click()
      await (await chooserPromise).setFiles(fixtureFolder)

      const dialog = page.locator('dialog[open]')
      await expect(dialog.getByText('工程初始化未完成', { exact: true })).toBeVisible()
      await expect(dialog).not.toContainText('D:/secret')
      await expect(dialog.getByRole('button', { name: '重新构建' })).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0)
      await page.screenshot({
        path: path.join(evidenceRoot, `04-import-1309-${size}.png`)
      })

      await dialog.getByRole('button', { name: '重新构建' }).click()
      await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
      await expect(page.getByTestId('project-card').filter({ hasText: 'e2e' })).toBeVisible()
    })

    test('重命名与编辑卡片弹窗不被反馈条遮挡', async ({ page }) => {
      await openWorkbench(page)
      await expect(page.getByTestId('rf__node-card-doc')).toBeVisible()
      await page.getByTestId('input-folder-row').filter({ hasText: '参考资料' }).dblclick()
      await expect(page.getByTestId('input-source-row').first()).toBeVisible()

      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByTestId('input-source-row').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: '重命名' }).click()
      await expect(page.getByRole('heading', { name: '重命名文件' })).toBeVisible()
      await expectFeedbackBand(page)
      await page.screenshot({
        path: path.join(evidenceRoot, `05-rename-dialog-${size}.png`)
      })
      await page.getByRole('button', { name: '取消' }).click()
      await expect(page.locator('dialog[open]')).toHaveCount(0)

      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByTestId('rf__node-card-doc').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '编辑标题和简介' }).click()
      await expect(page.getByRole('heading', { name: '编辑输入卡片' })).toBeVisible()
      await expectFeedbackBand(page)
      await page.screenshot({
        path: path.join(evidenceRoot, `06-edit-card-dialog-${size}.png`)
      })
    })

    test('新建项目弹窗没有反馈条覆盖', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: /新建空白画布/ })).toBeVisible()
      await page.getByRole('button', { name: /新建空白画布/ }).click()
      await expect(page.getByRole('heading', { name: '新建项目' })).toBeVisible()
      expect(await page.locator('[data-testid="workbench-feedback"]').count()).toBe(0)
      await page.screenshot({
        path: path.join(evidenceRoot, `07-new-project-dialog-${size}.png`)
      })
    })

    test('扩展 JSON 提示按供应商区分 User-Agent 覆盖关系', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: /新建空白画布/ })).toBeVisible()
      await page.getByRole('button', { name: /连接设置/ }).click()
      await expect(page.getByRole('heading', { name: '连接设置' })).toBeVisible()
      await page.locator('#connection-extension-entry').click()
      const openAiHint = page.getByText('OpenAI 兼容下，自定义 User-Agent 可能被 SDK 覆盖。')
      await expect(openAiHint).toBeVisible()
      await openAiHint.scrollIntoViewIfNeeded()
      await page.screenshot({
        path: path.join(evidenceRoot, `08-connection-hint-openai-${size}.png`)
      })

      await page.locator('#provider-id').click()
      await page.getByRole('option', { name: 'Anthropic' }).click()
      const anthropicHint = page.getByText('Anthropic 会保留自定义 User-Agent。')
      await expect(anthropicHint).toBeVisible()
      await expect(openAiHint).toHaveCount(0)
      await anthropicHint.scrollIntoViewIfNeeded()
      await page.screenshot({
        path: path.join(evidenceRoot, `09-connection-hint-anthropic-${size}.png`)
      })
    })
  })
}
