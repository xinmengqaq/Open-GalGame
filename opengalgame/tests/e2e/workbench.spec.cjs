const { test, expect } = require('@playwright/test')

const { seedGuidePreference } = require('./support/guide-preference.cjs')

async function openWorkbench(page, search = '') {
  await seedGuidePreference(page)
  await page.goto(`/${search}`)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
}

async function expectDialogCentered(page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const dialog = [...document.querySelectorAll('dialog[open]')].at(-1)
          if (!(dialog instanceof HTMLDialogElement)) return Infinity
          const rect = dialog.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          return Math.max(Math.abs(centerX - innerWidth / 2), Math.abs(centerY - innerHeight / 2))
        }),
      { timeout: 3000 }
    )
    .toBeLessThanOrEqual(2)
}

test('打开工程后显示输入目录和工程来源', async ({ page }) => {
  await openWorkbench(page)
  await expect(page.getByRole('heading', { name: '输入目录' })).toBeVisible()
  await expect(page.getByTestId('input-folder-row').first()).toBeVisible()
  await expect(page.getByTestId('input-catalog').getByText('参考资料')).toBeVisible()
  await page.getByTestId('input-folder-row').filter({ hasText: '参考资料' }).dblclick()
  await expect(page.getByTestId('input-catalog').getByText('角色与场景')).toBeVisible()
})

test('导入文件后出现在当前目录', async ({ page }) => {
  await openWorkbench(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入文件' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: '新角色设定.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 新角色\n')
  })
  await expect(page.getByTestId('input-catalog').getByText('新角色设定.md')).toBeVisible()
  await expect(page.getByText('已导入 1 个文件')).toBeVisible()
})

test('文件右键提供画布使用、剪切复制和删除', async ({ page }) => {
  await openWorkbench(page)
  await page.getByTestId('input-folder-row').filter({ hasText: '参考资料' }).dblclick()
  await page.getByTestId('input-source-row').first().click({ button: 'right' })
  const menu = page.getByTestId('file-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '在画布中使用' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '剪切' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '复制' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '重命名' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '删除' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '用系统程序打开' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('文件夹右键提供新建复制和删除', async ({ page }) => {
  await openWorkbench(page)
  await page
    .getByTestId('input-folder-row')
    .filter({ hasText: '参考资料' })
    .click({ button: 'right' })
  const menu = page.getByTestId('file-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-menu-kind', 'folder')
  await expect(menu.getByRole('menuitem', { name: '新建素材' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '新建文件夹' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '粘贴' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: '复制' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '重命名' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '删除' })).toBeVisible()
})

test('空白区域菜单提供新建和导入', async ({ page }) => {
  await openWorkbench(page)
  await page.getByTestId('catalog-blank-area').click({ button: 'right' })
  const menu = page.getByTestId('file-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-menu-kind', 'blank')
  await expect(menu.getByRole('menuitem', { name: '新建素材' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '新建文件夹' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '导入素材' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '粘贴' })).toBeDisabled()
})

test('页脚新建文件夹打开命名对话框', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '新建文件夹' }).click()
  await expect(page.getByRole('heading', { name: '新建文件夹' })).toBeVisible()
  await expect(page.locator('#catalog-name-draft')).toHaveValue('')
})

test('重命名失败保留输入', async ({ page }) => {
  await openWorkbench(page)
  await page.getByTestId('input-folder-row').filter({ hasText: '参考资料' }).dblclick()
  await page.getByTestId('input-source-row').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await expect(page.getByRole('heading', { name: '重命名文件' })).toBeVisible()
  await expect(page.locator('#catalog-name-draft')).toHaveValue('角色与场景')
  await page.getByRole('button', { name: '确定' }).click()
  await expect(page.getByRole('heading', { name: '重命名文件' })).toBeVisible()
  await expect(page.getByText('当前环境不能操作工程文件')).toBeVisible()
})

test('不可读取条目仍可打开右键菜单', async ({ page }) => {
  await openWorkbench(page)
  await page.getByTestId('input-folder-row').filter({ hasText: '场景背景' }).dblclick()
  await page.locator('[data-source-id="broken-bg"]').click({ button: 'right' })
  await expect(page.getByTestId('file-context-menu')).toBeVisible()
})

test('文档卡片进入只读文档层，Esc 返回', async ({ page }) => {
  await openWorkbench(page)
  await page.getByTestId('rf__node-card-doc').getByRole('button', { name: '打开文档层' }).click()
  await expect(page.getByTestId('document-layer')).toBeVisible()
  await expect(page.getByTestId('document-layer').locator('h2')).toHaveText('角色与场景')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('document-layer')).toHaveCount(0)
})

test('扫描失败与空目录区分', async ({ page }) => {
  await openWorkbench(page, '?workbench=fail')
  await expect(page.getByTestId('catalog-failed')).toBeVisible()
  await page.goto('/?workbench=empty')
  await page.getByRole('button', { name: '项目选择' }).click()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('catalog-empty')).toBeVisible()
  await expect(page.getByText('还没有可用输入来源')).toBeVisible()
})

test('浏览器只读夹具显示各类卡片与两条关联', async ({ page }) => {
  await openWorkbench(page)
  for (const cardId of [
    'card-doc',
    'card-bg',
    'card-video',
    'card-prompt',
    'card-audio',
    'card-anim',
    'card-fx'
  ]) {
    await expect(page.getByTestId(`rf__node-${cardId}`)).toBeVisible()
  }

  await page.getByRole('button', { name: '适配画布' }).click()

  const namedRelation = page.getByRole('button', { name: '编辑特殊关系：同一场景（已命名）' })
  const unnamedRelation = page.getByRole('button', { name: '编辑特殊关系：关系还没写（未命名）' })
  await expect(namedRelation).toBeVisible()
  await expect(unnamedRelation).toBeVisible()

  const dialog = page.getByRole('dialog', { name: '特殊关系' })
  await namedRelation.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#relation-name')).toHaveValue('同一场景')
  await expect(dialog.getByText('已命名关系', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '卸下记录' })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭弹窗' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)

  await unnamedRelation.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#relation-name')).toHaveValue('')
  await expect(dialog.getByText('未命名关系', { exact: true })).toBeVisible()
  await expect(dialog.getByText('这条线还没有关系记录。', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭弹窗' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
})

test('新建项目、重命名和编辑卡片弹窗视口居中，关闭重开仍居中', async ({ page }) => {
  await seedGuidePreference(page)
  await page.goto('/')
  const newProject = page.getByRole('button', { name: /新建空白画布/ })
  await newProject.click()
  await expect(page.getByRole('heading', { name: '新建项目' })).toBeVisible()
  await expectDialogCentered(page)
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await newProject.click()
  await expect(page.getByRole('heading', { name: '新建项目' })).toBeVisible()
  await expectDialogCentered(page)
  await page.getByRole('button', { name: '关闭弹窗' }).click()

  await openWorkbench(page)
  await page.getByTestId('input-folder-row').filter({ hasText: '参考资料' }).dblclick()
  await page.getByTestId('input-source-row').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await expect(page.getByRole('heading', { name: '重命名文件' })).toBeVisible()
  await expectDialogCentered(page)
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.getByTestId('input-source-row').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await expect(page.getByRole('heading', { name: '重命名文件' })).toBeVisible()
  await expectDialogCentered(page)
  await page.getByRole('button', { name: '关闭弹窗' }).click()

  await page.getByTestId('rf__node-card-doc').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑标题和简介' }).click()
  await expect(page.getByRole('heading', { name: '编辑输入卡片' })).toBeVisible()
  await expectDialogCentered(page)
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await page.getByTestId('rf__node-card-doc').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑标题和简介' }).click()
  await expect(page.getByRole('heading', { name: '编辑输入卡片' })).toBeVisible()
  await expectDialogCentered(page)
})

test('文档层和目录菜单挂载到 body，文档层覆盖视口', async ({ page }) => {
  await openWorkbench(page)
  await page.getByTestId('rf__node-card-doc').getByRole('button', { name: '打开文档层' }).click()
  const layer = page.getByTestId('document-layer')
  await expect(layer).toBeVisible()
  expect(await layer.evaluate((element) => element.parentElement === document.body)).toBe(true)
  const box = await layer.boundingBox()
  const viewport = page.viewportSize()
  expect(box.x).toBe(0)
  expect(box.y).toBe(0)
  expect(box.width).toBe(viewport.width)
  expect(box.height).toBe(viewport.height)
  await page.keyboard.press('Escape')
  await expect(layer).toHaveCount(0)

  await page.getByTestId('input-folder-row').filter({ hasText: '参考资料' }).dblclick()
  await page.getByTestId('input-source-row').first().click({ button: 'right' })
  const menu = page.getByTestId('file-context-menu')
  await expect(menu).toBeVisible()
  expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('导出与试玩预览在缺少可运行前置时保持禁用并给出可读原因', async ({ page }) => {
  await openWorkbench(page)

  const previewButton = page.getByRole('button', { name: '试玩预览', exact: true })
  await expect(previewButton).toBeDisabled()
  await expect(previewButton).toHaveAttribute('title', '暂时无法确认当前场景内容，不能打开试玩预览')

  const exportButton = page.getByRole('button', { name: '导出', exact: true })
  await expect(exportButton).toBeDisabled()
  /* 文案随可导出来源增加而变化；只要求禁用且有能说明下一步的可读原因。 */
  const exportHint = await exportButton.getAttribute('title')
  expect(exportHint).toBeTruthy()
  expect(exportHint).toMatch(/保存|生成|恢复|处理|导出/)
})

test('生成入口关闭抽屉后把焦点还给生成按钮', async ({ page }) => {
  await openWorkbench(page)
  const generate = page.getByRole('button', { name: '生成', exact: true })
  await generate.click()

  const dialog = page.getByRole('dialog', { name: '创作抽屉' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(generate).toBeFocused()
})
