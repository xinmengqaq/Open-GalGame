const { test, expect } = require('@playwright/test')

async function openWorkbench(page, search = '') {
  await page.goto(`/${search}`)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
}

async function openHistory(page) {
  await page.getByRole('button', { name: '历史记录', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创作抽屉' })
  await expect(dialog).toBeVisible()
  return dialog
}

/** 提示词卡展示态双击进入编辑；编辑中的正文是 combobox，不是 textbox。 */
async function fillPrompt(page, value) {
  const card = page
    .locator('article')
    .filter({ hasText: '用克制的对白写出屋顶上的第一句。' })
    .last()
  await card.dblclick()
  const prompt = page.getByRole('combobox', { name: '提示词正文' })
  await expect(prompt).toBeVisible()
  await prompt.fill(value)
}

test('历史抽屉显示工程历史、自动保存分组和记录详情', async ({ page }) => {
  await openWorkbench(page, '?history=fixture')
  const dialog = await openHistory(page)
  const worksPanel = dialog.getByRole('tabpanel', { name: '作品历史' })
  await expect(worksPanel.getByText('未寄出的第二封信', { exact: true })).toBeVisible()
  await expect(worksPanel.getByRole('heading', { name: '作品历史' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('button', { name: '手动保存', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '自动保存', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /确认生成候选/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /AI 生成/ }).first()).toBeVisible()

  const group = dialog.getByRole('button', { name: /4 条/ }).first()
  await expect(group).toBeVisible()
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByRole('button', { name: /周期自动保存/ }).first()).toBeVisible()

  await dialog.getByRole('button', { name: /保存场景编排/ }).click()
  const detail = dialog.getByRole('region', { name: '记录详情' })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('button', { name: '撤销这次操作' })).toBeEnabled()
  await expect(detail.getByRole('button', { name: '清理此条', exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: /清理此条及更早的手动保存/ })).toBeVisible()
  await expect(detail.getByText('手动保存', { exact: true })).toBeVisible()
  await expect(detail.getByText('更新了 4 张输入卡片、1 条关联和画布视口。')).toBeVisible()
})

test('筛选重置记录区并保留分页追加', async ({ page }) => {
  await openWorkbench(page, '?history=fixture')
  const dialog = await openHistory(page)
  const scroller = dialog.getByRole('region', { name: '历史记录' })
  await expect(dialog.getByText('已加载 20 条')).toBeVisible()

  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  const before = await scroller.evaluate((node) => node.scrollTop)
  await dialog.getByRole('button', { name: '加载更多' }).dispatchEvent('click')
  await expect(dialog.getByText('已加载 29 条')).toBeVisible()
  const after = await scroller.evaluate((node) => node.scrollTop)
  // 末尾没有下一页时“加载更多”入口隐藏，列表高度收紧会带来小幅回夹，但不能回到顶部。
  expect(after).toBeGreaterThan(100)
  expect(after).toBeGreaterThan(before - 40)

  await dialog.getByRole('button', { name: '手动保存', exact: true }).click()
  await expect(dialog.getByText('已加载 5 条')).toBeVisible()
  await expect(scroller).toHaveJSProperty('scrollTop', 0)
  await expect(dialog.getByRole('button', { name: /4 条/ })).toHaveCount(0)

  await dialog.getByRole('button', { name: '自动保存', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '自动保存', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(dialog.getByRole('button', { name: /自动保存 20 条/ })).toBeVisible()
  await expect(dialog.getByText('已加载 20 条')).toBeVisible()
})

test('撤销保留未保存编辑并显示恢复条', async ({ page }) => {
  await openWorkbench(page, '?history=fixture')
  await fillPrompt(page, '撤销前的临时改写')
  const dialog = await openHistory(page)

  await dialog.getByRole('button', { name: /保存场景编排/ }).click()
  const detail = dialog.getByRole('region', { name: '记录详情' })
  await detail.getByRole('button', { name: '撤销这次操作' }).click()

  const confirm = page.getByRole('alertdialog', { name: '撤销这次操作' })
  await expect(confirm).toBeVisible()
  await expect(
    confirm.getByText('当前未保存的编辑会先保留为本会话草稿，再执行撤销。')
  ).toBeVisible()
  await confirm.getByRole('button', { name: '撤销这次操作' }).click()
  await expect(detail.getByText('已回退')).toBeVisible()

  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByText('已保留撤销前的编辑')).toBeVisible()
  const recovery = page.getByRole('status').filter({ hasText: '已保留撤销前的编辑' })
  await expect(recovery.getByRole('button', { name: '恢复草稿' })).toBeEnabled()
  await recovery.getByRole('button', { name: '恢复草稿' }).click()
  await expect(page.getByLabel('提示词正文')).toHaveText('撤销前的临时改写')
  await expect(page.getByText('已保留撤销前的编辑')).toHaveCount(0)
})

test('撤销后视图刷新失败保留撤销事实，自动重读后恢复草稿', async ({ page }) => {
  await openWorkbench(page, '?history=fixture&historyRefresh=fail')
  await fillPrompt(page, '刷新失败前的改写')
  const dialog = await openHistory(page)
  await dialog.getByRole('button', { name: /保存场景编排/ }).click()
  await dialog
    .getByRole('region', { name: '记录详情' })
    .getByRole('button', { name: '撤销这次操作' })
    .click()
  const confirm = page.getByRole('alertdialog', { name: '撤销这次操作' })
  await confirm.getByRole('button', { name: '撤销这次操作' }).click()
  await expect(dialog.getByRole('region', { name: '记录详情' }).getByText('已回退')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  const stale = page.getByRole('status').filter({ hasText: '撤销已完成，正在重新读取视图…' })
  await expect(stale).toBeVisible()
  await expect(page.getByTestId('rf__node-card-doc')).toBeVisible()
  await expect(page.getByText('这次没有读到画布')).toHaveCount(0)
  await expect(page.getByText('已保留撤销前的编辑')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await expect(stale.getByRole('button', { name: '重新读取', exact: true })).toHaveCount(0)
  const recovery = page.getByRole('status').filter({ hasText: '已保留撤销前的编辑' })
  await expect(recovery.getByRole('button', { name: '恢复草稿' })).toBeDisabled()
  await expect(page.getByText('正在重新读取撤销后的视图，完成后即可恢复草稿。')).toBeVisible()

  await expect(stale).toHaveCount(0, { timeout: 5000 })
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await expect(recovery.getByRole('button', { name: '恢复草稿' })).toBeEnabled()
  await recovery.getByRole('button', { name: '恢复草稿' }).click()
  await expect(page.getByLabel('提示词正文')).toHaveText('刷新失败前的改写')
})

test('撤销冲突保留确认框并说明原因', async ({ page }) => {
  await openWorkbench(page, '?history=fixture')
  const dialog = await openHistory(page)
  await dialog.getByRole('button', { name: /4 条/ }).first().click()
  await dialog
    .getByRole('button', { name: /周期自动保存/ })
    .first()
    .click()
  const detail = dialog.getByRole('region', { name: '记录详情' })
  await detail.getByRole('button', { name: '撤销这次操作' }).click()

  const confirm = page.getByRole('alertdialog', { name: '撤销这次操作' })
  await confirm.getByRole('button', { name: '撤销这次操作' }).click()
  await expect(confirm.getByText('未撤销，目标已有后续改动。')).toBeVisible()
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(confirm).toBeHidden()
  await expect(detail.getByText('已回退')).toHaveCount(0)
})

test('清理单条历史后显示实际数量并从列表移除', async ({ page }) => {
  await openWorkbench(page, '?history=fixture')
  const dialog = await openHistory(page)
  await dialog.getByRole('button', { name: /确认生成候选/ }).click()
  const detail = dialog.getByRole('region', { name: '记录详情' })
  await detail.getByRole('button', { name: '清理此条', exact: true }).click()

  const confirm = page.getByRole('alertdialog', { name: '清理这条历史记录' })
  await expect(confirm).toBeVisible()
  await expect(confirm.getByText('只清理这条历史记录，不删除当前工程内容。')).toBeVisible()
  await confirm.getByRole('button', { name: '清理历史' }).click()
  await expect(page.getByText('已清理 1 条历史记录').first()).toBeVisible()
  await expect(dialog.getByRole('button', { name: /确认生成候选/ })).toHaveCount(0)
})

test('Esc 关闭抽屉并把焦点还给历史入口', async ({ page }) => {
  await openWorkbench(page, '?history=fixture')
  const entry = page.getByRole('button', { name: '历史记录', exact: true })
  await entry.click()
  await expect(page.getByRole('dialog', { name: '创作抽屉' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '创作抽屉' })).toBeHidden()
  await expect(entry).toBeFocused()
})

test('默认浏览器桥不伪造历史能力，读取失败可重试', async ({ page }) => {
  await openWorkbench(page)
  const dialog = await openHistory(page)
  await expect(dialog.getByText('历史记录读取失败')).toBeVisible()
  await expect(dialog.getByText('当前环境不能读取作品历史')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '重新读取' })).toBeVisible()
  await expect(dialog.getByText('还没有历史记录')).toHaveCount(0)
})
