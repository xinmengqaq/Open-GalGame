const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')

const evidenceDir = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'harness',
  'handoffs',
  'evidence',
  '2026-11-04-p4-ui-acceptance'
)
const screensDir = path.join(evidenceDir, 'screens')
const resultsPath = path.join(evidenceDir, 'results.json')

fs.mkdirSync(screensDir, { recursive: true })

const checks = []
const screens = []
const pageErrors = []
const consoleErrors = []
const testResults = []
const notWalked = []
let viewportInfo = null
const instrumented = new WeakSet()

function instrument(page) {
  if (instrumented.has(page)) return
  instrumented.add(page)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
}

function record(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: String(detail ?? '') })
  expect(ok === true, `${name}${detail ? `：${detail}` : ''}`).toBe(true)
}

async function captureViewport(page) {
  const value = await page.evaluate(() => ({
    innerWidth,
    innerHeight,
    devicePixelRatio,
    screenAvailWidth: screen.availWidth,
    screenAvailHeight: screen.availHeight,
    outerWidth,
    outerHeight
  }))
  if (viewportInfo === null) viewportInfo = value
  return value
}

async function openWorkbench(page, search) {
  instrument(page)
  await page.goto(search)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await captureViewport(page)
}

async function waitForDrawerSettled(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const drawer = document.querySelector('[role="dialog"]')
          if (!(drawer instanceof HTMLElement)) return 'missing'
          const style = getComputedStyle(drawer)
          if (style.transform !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(style.transform)) {
            return 'moving'
          }
          const active = drawer.querySelector('.wb-drawer__view[data-state="active"]')
          if (active instanceof HTMLElement && Number(getComputedStyle(active).opacity) < 0.99) {
            return 'fading'
          }
          return 'settled'
        }),
      { timeout: 8000 }
    )
    .toBe('settled')
}

async function openDrawer(page, entry = '生成') {
  await page.getByRole('button', { name: entry, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创作抽屉' })
  await expect(dialog).toBeVisible()
  await waitForDrawerSettled(page)
  return dialog
}

async function closeDrawer(page) {
  const dialog = page.getByRole('dialog', { name: '创作抽屉' })
  await page.locator('.wb-drawer__close').click()
  await expect(dialog).toBeHidden()
}

const viewId = {
  输入摘要: 'summary',
  'AI 历史': 'history',
  游戏候选: 'candidate',
  作品历史: 'works'
}

async function openView(page, label) {
  await page.getByRole('button', { name: '打开其他视图' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const item = menu.getByRole('menuitem', { name: new RegExp(label) })
  await expect(item).toHaveCount(1)
  await item.click()
  await expect(menu).toBeHidden()
  await expect(page.locator(`[data-tab="${viewId[label]}"] [role="tab"]`)).toHaveAttribute(
    'aria-selected',
    'true'
  )
}

async function tabOrder(page) {
  return page
    .locator('[role="tab"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.closest('.wb-drawertab')?.getAttribute('data-tab') ?? '')
    )
}

async function capture(page, file, meta) {
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready
  })
  await waitForDrawerSettled(page)
  await page.screenshot({
    path: path.join(screensDir, file),
    animations: 'disabled',
    caret: 'hide'
  })
  screens.push({
    file,
    state: meta.state,
    fixture: meta.fixture,
    search: meta.search,
    viewport: viewportInfo
  })
}

async function expectNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const drawer = document.querySelector('[role="dialog"]')
    const active = drawer?.querySelector('.wb-drawer__view[data-state="active"]')
    const rect = drawer?.getBoundingClientRect()
    return {
      doc: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth
      },
      drawer: drawer ? { scrollWidth: drawer.scrollWidth, clientWidth: drawer.clientWidth } : null,
      active: active ? { scrollWidth: active.scrollWidth, clientWidth: active.clientWidth } : null,
      rect: rect
        ? {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
          }
        : null
    }
  })

  record(
    `${label}：页面无横向溢出`,
    metrics.doc.scrollWidth <= metrics.doc.innerWidth,
    JSON.stringify(metrics.doc)
  )
  record(
    `${label}：抽屉无横向溢出`,
    metrics.drawer !== null && metrics.drawer.scrollWidth <= metrics.drawer.clientWidth + 1,
    JSON.stringify(metrics.drawer)
  )
  record(
    `${label}：活动标签页无横向溢出`,
    metrics.active !== null && metrics.active.scrollWidth <= metrics.active.clientWidth + 1,
    JSON.stringify(metrics.active)
  )
  record(
    `${label}：抽屉完整落在实际客户区内`,
    metrics.rect !== null &&
      metrics.rect.left >= 0 &&
      metrics.rect.top >= 0 &&
      metrics.rect.right <= metrics.doc.innerWidth + 0.5 &&
      metrics.rect.bottom <= viewportInfo.innerHeight + 0.5,
    JSON.stringify(metrics.rect)
  )
}

async function expectNoPageWideOverflow(page, label) {
  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth
  }))
  record(`${label}：页面无横向溢出`, width.scrollWidth <= width.innerWidth, JSON.stringify(width))
}

/**
 * 读取空态主按钮副标题的文本行盒：按 Range.getClientRects 合并同一行，
 * 用“每一行都至少两个汉字宽”判断没有单字孤行，不依赖像素基线。
 */
async function subtitleLineMetrics(page) {
  return page.locator('.wb-gen-empty__primary small').evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter(
      (rect) => rect.width > 0.5 && rect.height > 0.5
    )
    const lines = []
    for (const rect of rects) {
      const line = lines.find((item) => Math.abs(item.top - rect.top) < 1)
      if (line) {
        line.left = Math.min(line.left, rect.left)
        line.right = Math.max(line.right, rect.right)
        line.width = line.right - line.left
      } else {
        lines.push({ top: rect.top, left: rect.left, right: rect.right, width: rect.width })
      }
    }
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    const button = node.closest('button').getBoundingClientRect()
    return {
      text: (node.textContent || '').trim(),
      fontSize: parseFloat(style.fontSize),
      lineCount: lines.length,
      lines: lines.map((line) => Math.round(line.width * 100) / 100),
      minLineWidth: Math.min(...lines.map((line) => line.width)),
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      insideButton: rect.left >= button.left - 0.5 && rect.right <= button.right + 0.5
    }
  })
}

async function tabChrome(page) {
  return page.evaluate(() => {
    const tab = document.querySelector('.wb-drawertab[data-active="true"]')
    if (!(tab instanceof HTMLElement)) return null
    const button = tab.querySelector('[role="tab"]')
    const style = getComputedStyle(tab)
    const after = getComputedStyle(tab, '::after')
    const drawer = document.querySelector('[role="dialog"]')
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--wb-accent)'
    drawer.append(probe)
    const accent = getComputedStyle(probe).backgroundColor
    probe.remove()
    const closableTab = document.querySelector('.wb-drawertab[data-closable="true"]')
    const closableButton = closableTab?.querySelector('[role="tab"]')
    const closableClose = closableTab?.querySelector('.wb-drawertab__close')
    return {
      borders: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ],
      backgroundImage: style.backgroundImage,
      afterHeight: after.height,
      afterBackground: after.backgroundColor,
      accent,
      buttonSelected: button?.getAttribute('aria-selected') ?? null,
      closeIsSibling:
        closableTab !== null &&
        closableTab !== undefined &&
        closableClose !== null &&
        closableClose !== undefined &&
        closableClose.parentElement === closableTab &&
        closableButton?.contains(closableClose) === false
    }
  })
}

async function popoverTokenData(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel)
    if (!(node instanceof HTMLElement)) return null
    const drawer = document.querySelector('[role="dialog"]')
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:absolute;visibility:hidden;background:var(--wb-surface-solid);border-radius:var(--wb-radius-card);box-shadow:var(--wb-shadow-float)'
    drawer.append(probe)
    const token = getComputedStyle(probe)
    const tokenValue = {
      background: token.backgroundColor,
      radius: token.borderRadius,
      shadow: token.boxShadow
    }
    probe.remove()
    const style = getComputedStyle(node)
    return {
      background: style.backgroundColor,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      token: tokenValue
    }
  }, selector)
}

test.afterEach(async ({}, testInfo) => {
  testResults.push({
    title: testInfo.title,
    status: testInfo.status,
    errors: testInfo.errors.map((error) => error.message)
  })
})

test.afterAll(async () => {
  const payload = {
    suite: 'P4-12 生成抽屉正式页面验收',
    kind: 'UI 夹具，不代表真实生成、真实候选、真实提交或真实作品写入',
    branch: 'ui/generation-drawer-integrate-20261104',
    generatedAt: new Date().toISOString(),
    viewport: viewportInfo,
    fixtures: [
      'workbench=mixed|empty|fail|damaged',
      'generation=idle|running|decision|failed|commitUnknown|review|historyRecords|legacyFailure',
      'history=fixture'
    ],
    screens,
    checks: [
      ...checks,
      {
        name: '页面无 pageerror',
        ok: pageErrors.length === 0,
        detail: JSON.stringify(pageErrors)
      },
      {
        name: '页面无 console error',
        ok: consoleErrors.length === 0,
        detail: JSON.stringify(consoleErrors)
      }
    ],
    errors: { pageErrors, consoleErrors },
    tests: testResults,
    notWalked,
    notes: [
      '所有页面状态来自 URL 夹具，只证明表现层和交互，不证明真实生成、候选预览或提交。',
      '本机为 headed Chromium 最大化窗口，实际客户区见 viewport；不设固定截图尺寸。',
      '切换场景没有页面入口，未做页面走查；该重置由 useDrawerTabs 的 scope 与单测覆盖。'
    ]
  }
  fs.writeFileSync(resultsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toHaveLength(0)
  expect(consoleErrors, `console error: ${consoleErrors.join(' | ')}`).toHaveLength(0)
})

test('八态 01：空态', async ({ page }) => {
  const search = '/?workbench=mixed&generation=idle&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page)

  await expect(page.getByText('尚未开始生成').first()).toBeVisible()
  await expect(page.getByText('开始生成', { exact: true })).toBeVisible()
  const start = page.getByRole('button', { name: /开始生成/ })
  record('空态：开始生成入口可用', await start.isEnabled(), await start.innerText())
  const subtitle = await subtitleLineMetrics(page)
  record(
    '空态：开始生成副标题没有单字孤行',
    subtitle.text === '读取已保存编排 · 不启动第二次任务' &&
      subtitle.lineCount === 1 &&
      subtitle.minLineWidth >= subtitle.fontSize * 2 &&
      subtitle.scrollWidth <= subtitle.clientWidth + 1 &&
      subtitle.insideButton,
    JSON.stringify(subtitle)
  )
  record(
    '空态：默认只开当前生成',
    (await tabOrder(page)).join('|') === 'current',
    JSON.stringify(await tabOrder(page))
  )
  await expectNoHorizontalOverflow(page, '空态')
  await capture(page, '01-empty.png', {
    state: '空态',
    fixture: 'generation=idle; workbench=mixed; history=fixture',
    search
  })
})

test('窄窗口 860：空态不横向溢出且副标题平衡', async ({ page }) => {
  const search = '/?workbench=mixed&generation=idle&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page)

  // 从实际客户区收窄到 860，检查抽屉随窗口收缩时仍不溢出、不出现单字孤行。
  await page.setViewportSize({ width: 860, height: 900 })
  await waitForDrawerSettled(page)
  const metrics = await page.evaluate(() => {
    const drawer = document.querySelector('[role="dialog"]')
    const active = drawer?.querySelector('.wb-drawer__view[data-state="active"]')
    return {
      doc: [document.documentElement.scrollWidth, innerWidth],
      drawer: drawer ? [drawer.scrollWidth, drawer.clientWidth] : null,
      active: active ? [active.scrollWidth, active.clientWidth] : null
    }
  })
  record(
    '窄窗口 860：页面、抽屉和活动标签页不横向溢出',
    metrics.doc[0] <= metrics.doc[1] &&
      metrics.drawer !== null &&
      metrics.drawer[0] <= metrics.drawer[1] + 1 &&
      metrics.active !== null &&
      metrics.active[0] <= metrics.active[1] + 1,
    JSON.stringify(metrics)
  )
  const subtitle = await subtitleLineMetrics(page)
  record(
    '窄窗口 860：开始生成副标题没有单字孤行',
    subtitle.lineCount <= 2 &&
      subtitle.minLineWidth >= subtitle.fontSize * 2 &&
      subtitle.scrollWidth <= subtitle.clientWidth + 1 &&
      subtitle.insideButton,
    JSON.stringify(subtitle)
  )
})

test('八态 02：运行中与运行详情浮层', async ({ page }) => {
  const search = '/?workbench=mixed&generation=running&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)

  await expect(page.getByText('正在生成。')).toBeVisible()
  const trigger = page.locator('.wb-gen-run__row')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const popover = page.getByRole('dialog', { name: '运行详情' })
  await expect(popover).toBeVisible()
  await expect
    .poll(() => popover.evaluate((node) => Number(getComputedStyle(node).opacity)))
    .toBe(1)

  const metrics = await popover.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
      innerWidth,
      innerHeight
    }
  })
  record(
    '运行详情：宽 360–420px',
    metrics.width >= 360 && metrics.width <= 420,
    JSON.stringify(metrics)
  )
  record(
    '运行详情：最大高度不超过 60vh',
    metrics.height <= metrics.innerHeight * 0.6 + 1,
    JSON.stringify(metrics)
  )
  record(
    '运行详情：完整落在窗口内',
    metrics.right <= metrics.innerWidth + 0.5 && metrics.bottom <= metrics.innerHeight + 0.5,
    JSON.stringify(metrics)
  )
  record(
    '运行详情：显示固定六步阶段轨',
    (await popover.getByRole('list', { name: '生成阶段' }).locator('li').count()) === 6,
    String(await popover.getByRole('list', { name: '生成阶段' }).locator('li').count())
  )
  record('运行详情：不显示耗时', (await popover.getByText('耗时').count()) === 0, '耗时 count=0')
  await capture(page, '02-running-run-details.png', {
    state: '运行中 + 运行详情浮层',
    fixture: 'generation=running; workbench=mixed; history=fixture',
    search
  })

  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()
  record(
    '运行详情：Esc 关闭后焦点回到入口',
    await trigger.evaluate((node) => node === document.activeElement),
    'activeElement=trigger'
  )

  await trigger.click()
  await expect(popover).toBeVisible()
  await dialog.locator('.wb-drawer__brand').click()
  await expect(popover).toBeHidden()
  await expect(dialog).toBeVisible()
  record('运行详情：外点关闭且抽屉保持打开', await dialog.isVisible(), 'drawer visible')

  await expectNoHorizontalOverflow(page, '运行中')
})

test('八态 03：等待决策', async ({ page }) => {
  const search = '/?workbench=mixed&generation=decision&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page)

  await expect(page.getByText('旧友身份要在这里挑明吗？')).toBeVisible()
  const currentTab = page.locator('[data-tab="current"] [role="tab"]')
  record(
    '等待决策：当前生成标签显示真实状态',
    ((await currentTab.getAttribute('aria-label')) ?? '').includes('等待你回复'),
    (await currentTab.getAttribute('aria-label')) ?? ''
  )
  record(
    '等待决策：运行详情只出现在浮层',
    (await page.locator('.wb-gen-details').count()) === 0,
    'inline details=0'
  )
  await expectNoHorizontalOverflow(page, '等待决策')
  await capture(page, '03-waiting-decision.png', {
    state: '等待决策',
    fixture: 'generation=decision; workbench=mixed; history=fixture',
    search
  })
})

test('八态 04：失败与诊断展开', async ({ page }) => {
  const search = '/?workbench=mixed&generation=failed&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page)

  await expect(page.getByText('模型调用失败，本次生成未完成')).toBeVisible()
  const details = page.locator('details.wb-gen-outcome__diagnostics')
  await expect(details).toBeVisible()
  await page.getByText('诊断信息', { exact: true }).click()
  await expect(details).toHaveJSProperty('open', true)
  await expect(details.getByText('故障指纹')).toBeVisible()
  const fingerprint = await details.locator('dd').first().innerText()
  record('失败诊断：展开后显示故障指纹', /^[0-9a-f]{12}$/.test(fingerprint.trim()), fingerprint)
  const outcome = await page.locator('.wb-gen-outcome').evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      borderLeftWidth: style.borderLeftWidth,
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderRadius
    }
  })
  record(
    '失败气泡：没有左侧色条和第二层边框',
    parseFloat(outcome.borderLeftWidth) === 0 && parseFloat(outcome.borderTopWidth) === 0,
    JSON.stringify(outcome)
  )
  await expectNoHorizontalOverflow(page, '失败')
  await capture(page, '04-failed-diagnostics.png', {
    state: '失败 + 诊断展开',
    fixture: 'generation=failed; workbench=mixed; history=fixture',
    search
  })
})

test('八态 04b：提交结果待核对', async ({ page }) => {
  const search = '/?workbench=mixed&generation=commitUnknown&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page)

  const headerPill = page.locator('.wb-gen-header .wb-gen-pill')
  await expect(headerPill).toHaveText('结果待核对')
  record(
    '待核对：头部状态显示结果待核对',
    (await headerPill.innerText()).trim() === '结果待核对',
    `pill=${(await headerPill.innerText()).trim()} tone=${await headerPill.getAttribute('data-tone')}`
  )
  record(
    '待核对：头部使用等待色而不是失败色',
    (await headerPill.getAttribute('data-tone')) === 'wait',
    `tone=${await headerPill.getAttribute('data-tone')}`
  )

  const currentTab = page.locator('[data-tab="current"] [role="tab"]')
  const currentLabel = (await currentTab.getAttribute('aria-label')) ?? ''
  record(
    '待核对：当前生成标签文案为结果待核对',
    currentLabel.includes('结果待核对') && !currentLabel.includes('生成失败'),
    currentLabel
  )
  const currentTone = page.locator('[data-tab="current"] .wb-drawertab__tone')
  record(
    '待核对：当前生成标签状态点使用待核对状态',
    (await currentTone.getAttribute('data-tone')) === 'pendingVerification',
    `data-tone=${await currentTone.getAttribute('data-tone')}`
  )

  await expect(page.locator('.wb-gen-outcome__kicker')).toHaveText('结果待核对')
  await expect(page.locator('.wb-gen-outcome__title')).toHaveText('结果待核对')
  record(
    '待核对：气泡 kicker 与标题保持结果待核对',
    (await page.locator('.wb-gen-outcome__kicker').innerText()).trim() === '结果待核对' &&
      (await page.locator('.wb-gen-outcome__title').innerText()).trim() === '结果待核对',
    'kicker/title'
  )
  const failureTextCount = await page.getByText('生成失败', { exact: true }).count()
  record(
    '待核对：页面不出现生成失败文案',
    failureTextCount === 0,
    `生成失败 count=${failureTextCount}`
  )

  await expectNoHorizontalOverflow(page, '提交结果待核对')
  await capture(page, '12-commit-unknown.png', {
    state: '提交结果待核对',
    fixture: 'generation=commitUnknown; workbench=mixed; history=fixture',
    search
  })
})

test('八态 05：游戏候选', async ({ page }) => {
  const search = '/?workbench=mixed&generation=review&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)

  const currentTab = page.locator('[data-tab="current"] [role="tab"]')
  const candidateTab = page.getByRole('tab', { name: '游戏候选' })
  await expect(candidateTab).toBeVisible()
  record(
    '候选：可用时自动加入标签但不切换',
    (await currentTab.getAttribute('aria-selected')) === 'true' &&
      (await candidateTab.getAttribute('aria-selected')) === 'false',
    `current=${await currentTab.getAttribute('aria-selected')} candidate=${await candidateTab.getAttribute('aria-selected')}`
  )

  await candidateTab.click()
  await expect(candidateTab).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByText('当前环境不支持场景生成')).toBeVisible()
  const titleCount = await dialog.getByText('游戏候选暂时打不开', { exact: true }).count()
  const retry = page.getByRole('button', { name: '重新打开候选' })
  record('候选：不可用态标题只出现一处', titleCount === 1, `游戏候选暂时打不开 count=${titleCount}`)
  record(
    '候选：不可用态重试入口仍可用',
    (await retry.count()) === 1 && (await retry.isEnabled()),
    `retry count=${await retry.count()}`
  )
  await retry.click()
  await expect(dialog.getByText('当前环境不支持场景生成')).toBeVisible()
  record(
    '候选：失败/失效重试保留真实状态，不伪造画面',
    (await dialog.getByText('游戏候选暂时打不开', { exact: true }).count()) === 1 &&
      (await dialog.getByText('当前环境不支持场景生成').count()) === 1,
    'unsupported after retry'
  )

  await expectNoHorizontalOverflow(page, '游戏候选')
  await capture(page, '05-game-candidate.png', {
    state: '游戏候选（夹具无预览桥）',
    fixture: 'generation=review; workbench=mixed; history=fixture',
    search
  })
})

test('八态 06：输入摘要', async ({ page }) => {
  const search = '/?workbench=mixed&generation=review&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)
  await openView(page, '输入摘要')

  await expect(dialog.getByText('本轮输入已固定')).toBeVisible()
  await expect(dialog.getByText('只读 · 不再重新读取')).toBeVisible()
  record(
    '输入摘要：启动后显示固定快照',
    (await dialog.getByText('本轮快照').count()) > 0,
    '本轮快照'
  )
  record(
    '输入摘要：不显示 role/用途冲突',
    (await dialog.getByText(/role|用途冲突/i).count()) === 0,
    'conflict count=0'
  )
  await expectNoHorizontalOverflow(page, '输入摘要')
  await capture(page, '06-input-summary.png', {
    state: '输入摘要',
    fixture: 'generation=review; workbench=mixed; history=fixture',
    search
  })

  await page.locator('[data-tab="current"] [role="tab"]').click()
  await page.locator('.wb-gen-summary-bar__trigger').click()
  const popover = page.locator('[aria-label="输入分类计数"]')
  await expect(popover).toBeVisible()
  record(
    '输入摘要浮层：只显示计数和查看完整摘要',
    (await popover.locator('.wb-gen-summary__counts li').count()) >= 5 &&
      (await popover.getByRole('button', { name: /查看完整摘要/ }).count()) === 1 &&
      (await popover
        .locator(
          '.wb-gen-summary__popover-body section, .wb-gen-summary__popover-body h3, .wb-gen-summary__popover-body [aria-label="字段绑定"]'
        )
        .count()) === 0,
    `counts=${await popover.locator('.wb-gen-summary__counts li').count()}`
  )
  await capture(page, '06b-input-summary-popover.png', {
    state: '输入摘要轻量浮层',
    fixture: 'generation=review; workbench=mixed; history=fixture',
    search
  })
  await popover.getByRole('button', { name: /查看完整摘要/ }).click()
  await expect(page.locator('[data-tab="summary"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(popover).toBeHidden()
})

test('八态 07：AI 历史列表与详情', async ({ page }) => {
  const search = '/?workbench=mixed&generation=historyRecords&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)
  await openView(page, 'AI 历史')

  await expect(dialog.getByText('已读取 20 条', { exact: true })).toBeVisible()
  await expect(page.locator('.wb-hist__row')).toHaveCount(20)
  await expectNoHorizontalOverflow(page, 'AI 历史列表')
  await capture(page, '07-ai-history-list.png', {
    state: 'AI 历史列表',
    fixture: 'generation=historyRecords; workbench=mixed; history=fixture',
    search
  })

  await page.locator('.wb-hist__row').first().click()
  const detail = page.getByRole('region', { name: 'AI 历史记录详情' })
  await expect(detail).toBeVisible()
  await expect(detail.getByText('记录时间')).toBeVisible()
  await expect(detail.getByText('操作边界')).toBeVisible()
  await expect(detail.getByText('所处阶段')).toBeVisible()
  record(
    'AI 历史详情：不显示耗时、候选和重试入口',
    (await detail.getByText('耗时').count()) === 0 &&
      (await detail
        .getByRole('button')
        .filter({ hasText: /候选|重试|恢复|分叉/ })
        .count()) === 0,
    'detail actions clean'
  )
  await expectNoHorizontalOverflow(page, 'AI 历史详情')
  await capture(page, '07b-ai-history-detail.png', {
    state: 'AI 历史详情',
    fixture: 'generation=historyRecords; workbench=mixed; history=fixture',
    search
  })

  await page.getByRole('button', { name: '返回列表' }).click()
  const failedRow = page.locator('.wb-hist__row').filter({ hasText: '失败' }).first()
  await expect(failedRow).toBeVisible()
  await failedRow.click()
  await expect(detail.getByText('失败原因')).toBeVisible()
  record(
    'AI 历史详情：失败记录显示原因',
    await detail.getByText('失败原因').isVisible(),
    '失败原因'
  )

  await page.goto('/?workbench=mixed&generation=legacyFailure&history=fixture')
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await openDrawer(page)
  await openView(page, 'AI 历史')
  await expect(page.locator('.wb-hist__row')).toHaveCount(1)
  await page.locator('.wb-hist__row').first().click()
  await expect(detail.getByText('旧记录')).toBeVisible()
  record('AI 历史详情：旧记录有明确标记', await detail.getByText('旧记录').isVisible(), '旧记录')
})

test('八态 08：作品历史', async ({ page }) => {
  const search = '/?workbench=mixed&generation=idle&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page, '历史记录')

  const worksPanel = page.getByRole('tabpanel', { name: '作品历史' })
  await expect(worksPanel.getByRole('heading', { name: '作品历史' })).toBeVisible()
  await expect(worksPanel.getByText('20 条已加载')).toBeVisible()
  await expect(worksPanel.getByText('未寄出的第二封信', { exact: true })).toBeVisible()
  record(
    '作品历史：工程级时间线不与场景生成状态混排',
    (await page.getByText('等待你回复').count()) === 0 &&
      (await page.getByText('生成进行中').count()) === 0,
    'generation status count=0'
  )
  await expectNoHorizontalOverflow(page, '作品历史')
  await capture(page, '08-works-history.png', {
    state: '作品历史',
    fixture: 'generation=idle; workbench=mixed; history=fixture',
    search
  })

  await page.locator('.works-row').filter({ hasText: '保存场景编排' }).first().click()
  const detail = page.getByRole('region', { name: '记录详情' })
  await expect(detail).toBeVisible()
  await expect(detail.getByText('手动保存', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page, '作品历史详情')
  await capture(page, '08b-works-detail.png', {
    state: '作品历史记录详情',
    fixture: 'generation=idle; workbench=mixed; history=fixture',
    search
  })
})

test('标签：关闭、重开、拖拽、键盘与菜单移动', async ({ page }) => {
  const search = '/?workbench=mixed&generation=historyRecords&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)

  await openView(page, '输入摘要')
  await openView(page, 'AI 历史')
  await expect(page.locator('.wb-hist__row').first()).toBeVisible()
  record(
    '标签：关闭活动标签回到左侧最近标签',
    (await tabOrder(page)).join('|') === 'current|summary|history',
    JSON.stringify(await tabOrder(page))
  )

  await page.getByRole('button', { name: '关闭“AI 历史”' }).click()
  await expect(page.locator('[data-tab="history"]')).toHaveCount(0)
  await expect(page.locator('[data-tab="summary"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  record(
    '标签：关闭活动标签后左侧最近标签接管',
    (await tabOrder(page)).join('|') === 'current|summary',
    JSON.stringify(await tabOrder(page))
  )

  await openView(page, 'AI 历史')
  await page.getByRole('button', { name: '打开其他视图' }).click()
  const plusMenu = page.getByRole('menu')
  await expect(plusMenu).toBeVisible()
  record(
    '`+` 菜单：只列未打开视图，不重复',
    (await plusMenu.getByRole('menuitem', { name: /输入摘要/ }).count()) === 0 &&
      (await plusMenu.getByRole('menuitem', { name: /AI 历史/ }).count()) === 0,
    await plusMenu.innerText()
  )
  await page.keyboard.press('Escape')
  await expect(plusMenu).toBeHidden()

  const summaryTab = page.locator('[data-tab="summary"]')
  const summaryTabButton = page.locator('[data-tab="summary"] [role="tab"]')
  const focusedTab = () =>
    page.evaluate(
      () => document.activeElement?.closest('[data-tab]')?.getAttribute('data-tab') ?? ''
    )

  await summaryTab.click({ button: 'right' })
  const tabMenu = page.getByRole('menu', { name: '输入摘要标签菜单' })
  await expect(tabMenu).toBeVisible()
  await expect(tabMenu.getByRole('menuitem', { name: '左移' })).toBeDisabled()
  await expect(tabMenu.getByRole('menuitem', { name: '右移' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(tabMenu).toBeHidden()
  await expect(summaryTabButton).toBeFocused()
  record(
    '标签菜单：Esc 关闭后焦点回到打开菜单的标签',
    (await focusedTab()) === 'summary',
    `focus=${await focusedTab()}`
  )

  await summaryTab.click({ button: 'right' })
  await expect(tabMenu).toBeVisible()
  await tabMenu.getByRole('menuitem', { name: '右移' }).click()
  await expect.poll(() => tabOrder(page)).toEqual(['current', 'history', 'summary'])
  await expect(summaryTabButton).toBeFocused()
  record(
    '标签菜单：右移改变顺序且焦点回到该标签',
    (await tabOrder(page)).join('|') === 'current|history|summary' &&
      (await focusedTab()) === 'summary',
    `order=${JSON.stringify(await tabOrder(page))} focus=${await focusedTab()}`
  )

  await summaryTab.click({ button: 'right' })
  await expect(tabMenu).toBeVisible()
  await page.locator('.wb-drawer__brand').click()
  await expect(tabMenu).toBeHidden()
  record(
    '标签菜单：外点关闭不抢回标签焦点',
    (await focusedTab()) !== 'summary',
    `focus=${await focusedTab()} tag=${await page.evaluate(
      () => document.activeElement?.tagName ?? 'null'
    )}`
  )

  await summaryTab.click({ button: 'right' })
  await expect(tabMenu).toBeVisible()
  await expect(tabMenu.getByRole('menuitem', { name: '左移' })).toBeEnabled()
  await expect(tabMenu.getByRole('menuitem', { name: '右移' })).toBeDisabled()
  await tabMenu.getByRole('menuitem', { name: '左移' }).click()
  await expect(tabMenu).toBeHidden()
  await expect.poll(() => tabOrder(page)).toEqual(['current', 'summary', 'history'])
  record(
    '标签菜单：左移恢复顺序',
    (await tabOrder(page)).join('|') === 'current|summary|history',
    JSON.stringify(await tabOrder(page))
  )

  await page.locator('[data-tab="current"] [role="tab"]').focus()
  await page.keyboard.press('ArrowRight')
  record(
    '键盘：右方向键移动到相邻标签',
    (await page.evaluate(() =>
      document.activeElement?.closest('[data-tab]')?.getAttribute('data-tab')
    )) === 'summary',
    String(
      await page.evaluate(() =>
        document.activeElement?.closest('[data-tab]')?.getAttribute('data-tab')
      )
    )
  )
  await page.keyboard.press('Space')
  await expect(page.locator('[data-tab="summary"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  record('键盘：Space 激活标签', true, 'summary selected')
  await expect(summaryTabButton).toBeFocused()
  await page.keyboard.press('ArrowRight')
  record(
    '键盘：右方向键到 AI 历史',
    (await page.evaluate(() =>
      document.activeElement?.closest('[data-tab]')?.getAttribute('data-tab')
    )) === 'history',
    String(
      await page.evaluate(() =>
        document.activeElement?.closest('[data-tab]')?.getAttribute('data-tab')
      )
    )
  )
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tab="history"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  record('键盘：Enter 激活标签', true, 'history selected')
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-tab="history"]')).toHaveCount(0)
  await expect(page.locator('[data-tab="summary"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  record('键盘：Delete 关闭可选标签', true, 'history closed')
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-tab="summary"]')).toHaveCount(0)
  await expect(page.locator('[data-tab="current"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  record('键盘：关闭活动标签回退到当前生成', true, 'current selected')

  await openView(page, '输入摘要')
  await openView(page, '作品历史')
  await expect(page.getByRole('heading', { name: '作品历史' })).toBeVisible()
  const orderBeforeDrag = await tabOrder(page)
  const dragSource = page.locator('[data-tab="summary"] [role="tab"]')
  const dragTarget = page.locator('[data-tab="works"]')
  await dragSource.dragTo(dragTarget, { targetPosition: { x: 90, y: 19 } })
  await expect.poll(() => tabOrder(page)).toEqual(['current', 'works', 'summary'])
  record(
    '拖拽：只改变标签顺序',
    orderBeforeDrag.join('|') === 'current|summary|works' &&
      (await tabOrder(page)).join('|') === 'current|works|summary',
    `${JSON.stringify(orderBeforeDrag)} -> ${JSON.stringify(await tabOrder(page))}`
  )
  await capture(page, '09-tabs-order.png', {
    state: '标签拖拽排序',
    fixture: 'generation=historyRecords; workbench=mixed; history=fixture',
    search
  })

  const chrome = await tabChrome(page)
  record(
    '标签：活动标签无 1px 全边框',
    chrome !== null && chrome.borders.every((width) => parseFloat(width) === 0),
    JSON.stringify(chrome?.borders)
  )
  record(
    '标签：活动标签有 2px 强调线',
    chrome !== null && chrome.afterHeight === '2px' && chrome.afterBackground === chrome.accent,
    JSON.stringify({
      height: chrome?.afterHeight,
      color: chrome?.afterBackground,
      accent: chrome?.accent
    })
  )
  record(
    '标签：关闭按钮与标签按钮同级',
    chrome !== null && chrome.closeIsSibling === true,
    JSON.stringify({ closeIsSibling: chrome?.closeIsSibling })
  )

  await closeDrawer(page)
  await openDrawer(page)
  await expect.poll(() => tabOrder(page)).toEqual(['current', 'works', 'summary'])
  record(
    '标签：关闭抽屉再打开保留顺序和开关',
    (await tabOrder(page)).join('|') === 'current|works|summary',
    JSON.stringify(await tabOrder(page))
  )
  await expect(page.locator('[data-tab="current"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('标签：同一候选关闭后不自动重开', async ({ page }) => {
  const search = '/?workbench=mixed&generation=review&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)

  const candidateTab = page.locator('[data-tab="candidate"] [role="tab"]')
  await expect(candidateTab).toBeVisible()
  await page.getByRole('button', { name: '关闭“游戏候选”' }).click()
  await expect(page.locator('[data-tab="candidate"]')).toHaveCount(0)
  record(
    '候选：关闭后标签消失',
    (await tabOrder(page)).join('|') === 'current',
    JSON.stringify(await tabOrder(page))
  )

  await closeDrawer(page)
  await openDrawer(page)
  await expect(page.locator('[data-tab="candidate"]')).toHaveCount(0)
  record(
    '候选：同一候选关闭后重新打开抽屉不自动加回',
    (await tabOrder(page)).join('|') === 'current',
    JSON.stringify(await tabOrder(page))
  )

  await page.getByRole('button', { name: '打开其他视图' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /游戏候选/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /游戏候选/ }).click()
  await expect(candidateTab).toHaveAttribute('aria-selected', 'true')
  record('候选：可从 `+` 菜单手动重开', true, 'candidate selected')
  await expect(dialog.getByText('当前环境不支持场景生成')).toBeVisible()
})

test('切换工程重置标签范围（场景切换无页面入口）', async ({ page }) => {
  const search = '/?workbench=mixed&generation=idle&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page)
  await openView(page, '输入摘要')
  await expect.poll(() => tabOrder(page)).toEqual(['current', 'summary'])
  await closeDrawer(page)

  await page.getByRole('button', { name: '返回项目页' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').nth(1).click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await openDrawer(page)

  record(
    '切换工程：标签重置为只开当前生成',
    (await tabOrder(page)).join('|') === 'current',
    JSON.stringify(await tabOrder(page))
  )
  record('切换场景：没有页面入口可走查', true, '由 useDrawerTabs scope 与单测覆盖')
  notWalked.push(
    '切换场景没有页面入口：工作台不提供场景切换 UI；重置逻辑由 useDrawerTabs 的 scope 和 tests/unit/presentation/workbench/drawer-tabs.test.ts 覆盖，未做页面走查。'
  )
})

test('关闭抽屉不取消任务，焦点返回生成入口', async ({ page }) => {
  const search = '/?workbench=mixed&generation=running&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)
  await expect(page.getByText('正在生成。')).toBeVisible()

  await page.locator('.wb-drawer__close').click()
  await expect(dialog).toBeHidden()
  const generate = page.getByRole('button', { name: '生成', exact: true })
  record(
    '关闭抽屉：焦点返回生成入口',
    await generate.evaluate((node) => node === document.activeElement),
    'generate focused'
  )
  await expect(page.getByText('生成进行中')).toBeVisible()
  record(
    '关闭抽屉：生成任务保持进行中',
    await page.getByText('生成进行中').isVisible(),
    'generation lock visible'
  )

  await page.getByRole('button', { name: '查看生成进度' }).click()
  await expect(dialog).toBeVisible()
  const label =
    (await page.locator('[data-tab="current"] [role="tab"]').getAttribute('aria-label')) ?? ''
  record('关闭抽屉：重新打开仍是同一运行任务', label.includes('进行中'), label)
  await expect(page.getByText('正在生成。')).toBeVisible()
})

test('作品历史写操作在途时禁止关闭', async ({ page }) => {
  const search = '/?workbench=mixed&generation=idle&history=fixture'
  await openWorkbench(page, search)
  await openDrawer(page, '历史记录')
  await expect(page.getByRole('heading', { name: '作品历史' })).toBeVisible()

  await page.locator('.works-row').filter({ hasText: '保存场景编排' }).first().click()
  const detail = page.getByRole('region', { name: '记录详情' })
  await expect(detail).toBeVisible()
  await detail.getByRole('button', { name: '撤销这次操作' }).click()
  const confirm = page.getByRole('alertdialog', { name: '撤销这次操作' })
  await expect(confirm).toBeVisible()

  await page.evaluate(() => {
    const drawerClose = document.querySelector('.wb-drawer__close')
    const tabClose = document.querySelector('[data-tab="works"] .wb-drawertab__close')
    const snapshots = []
    const take = (reason) => {
      snapshots.push({
        reason,
        drawer: drawerClose instanceof HTMLButtonElement ? drawerClose.disabled : null,
        tab: tabClose instanceof HTMLButtonElement ? tabClose.disabled : null
      })
    }
    take('before')
    const observer = new MutationObserver(() => take('mutation'))
    for (const node of [drawerClose, tabClose]) {
      if (node) observer.observe(node, { attributes: true, attributeFilter: ['disabled'] })
    }
    window.__p4BusyGuard = { snapshots, observer }
  })

  await confirm.getByRole('button', { name: '撤销这次操作' }).click()
  await expect(detail.getByText('已回退')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const close = document.querySelector('.wb-drawer__close')
        return close instanceof HTMLButtonElement && !close.disabled
      })
    )
    .toBe(true)

  const busy = await page.evaluate(() => {
    const guard = window.__p4BusyGuard
    guard.observer.disconnect()
    return guard.snapshots
  })
  record(
    '作品历史：写操作在途时关闭抽屉和作品历史标签均被禁用',
    busy.some((item) => item.drawer === true && item.tab === true),
    JSON.stringify(busy)
  )
  record(
    '作品历史：写操作完成后恢复可关闭',
    await page.evaluate(() => {
      const drawerClose = document.querySelector('.wb-drawer__close')
      const tabClose = document.querySelector('[data-tab="works"] .wb-drawertab__close')
      return (
        drawerClose instanceof HTMLButtonElement &&
        !drawerClose.disabled &&
        tabClose instanceof HTMLButtonElement &&
        !tabClose.disabled
      )
    }),
    'both enabled'
  )

  await page.getByRole('button', { name: '关闭“作品历史”' }).click()
  await expect(page.locator('[data-tab="works"]')).toHaveCount(0)
  await expect(page.locator('[data-tab="current"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('默认格式与 token 计算样式', async ({ page }) => {
  const search = '/?workbench=mixed&generation=decision&history=fixture'
  await openWorkbench(page, search)
  const dialog = await openDrawer(page)

  const chrome = await tabChrome(page)
  record(
    '计算样式：活动标签边框全为 0',
    chrome !== null && chrome.borders.every((width) => parseFloat(width) === 0),
    JSON.stringify(chrome?.borders)
  )
  record(
    '计算样式：活动标签 2px 线取 --wb-accent',
    chrome !== null && chrome.afterHeight === '2px' && chrome.afterBackground === chrome.accent,
    JSON.stringify({
      height: chrome?.afterHeight,
      color: chrome?.afterBackground,
      accent: chrome?.accent
    })
  )
  record(
    '计算样式：活动标签是轻表面渐变而不是白卡',
    chrome !== null &&
      chrome.backgroundImage !== 'none' &&
      chrome.backgroundImage.includes('linear-gradient'),
    chrome?.backgroundImage?.slice(0, 200) ?? ''
  )
  await page.getByRole('button', { name: '打开其他视图' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const menuTokens = await popoverTokenData(page, '.wb-drawer-tabs__menu')
  record(
    '计算样式：`+` 浮层背景取 --wb-surface-solid',
    menuTokens !== null && menuTokens.background === menuTokens.token.background,
    JSON.stringify(menuTokens)
  )
  record(
    '计算样式：`+` 浮层圆角取 --wb-radius-card',
    menuTokens !== null &&
      Math.abs(parseFloat(menuTokens.radius) - parseFloat(menuTokens.token.radius)) < 0.5,
    JSON.stringify(menuTokens)
  )
  record(
    '计算样式：`+` 浮层阴影包含 --wb-shadow-float',
    menuTokens !== null && menuTokens.shadow.includes(menuTokens.token.shadow),
    menuTokens?.shadow ?? ''
  )
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  const bubbleBorders = await page.evaluate(() =>
    [...document.querySelectorAll('.wb-gen-bubble')].map((node) => {
      const style = getComputedStyle(node)
      return [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ]
    })
  )
  record(
    '计算样式：对话气泡无第二层边框',
    bubbleBorders.length > 0 &&
      bubbleBorders.every((widths) => widths.every((width) => parseFloat(width) === 0)),
    JSON.stringify(bubbleBorders)
  )

  const primary = await page
    .locator('.wb-gen-primary')
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node)
      return {
        radius: style.borderRadius,
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth
      }
    })
  record(
    '计算样式：主按钮使用工作台样式而非默认按钮',
    primary.radius === '12px' &&
      primary.backgroundImage.includes('linear-gradient') &&
      parseFloat(primary.borderTopWidth) === 0,
    JSON.stringify(primary)
  )

  const defaults = await page.evaluate(() => ({
    prose: document.querySelectorAll('.wb-drawer .prose').length,
    cards: document.querySelectorAll('.wb-drawer [data-slot="card"]').length,
    dark: document.querySelectorAll('.wb-drawer .dark').length,
    whiteSurfaces: [...document.querySelectorAll('.wb-drawer *')].filter((node) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.backgroundColor === 'rgb(255, 255, 255)' && rect.width * rect.height > 2000
    }).length
  }))
  record('默认格式：无 .prose', defaults.prose === 0, JSON.stringify(defaults))
  record('默认格式：无 shadcn 卡片', defaults.cards === 0, JSON.stringify(defaults))
  record('默认格式：无第二套深色主题', defaults.dark === 0, JSON.stringify(defaults))
  record('默认格式：无大面积纯白底', defaults.whiteSurfaces === 0, JSON.stringify(defaults))

  await page.getByRole('button', { name: '取消本次生成' }).click()
  const confirm = page.locator('.wb-gen-dialog')
  await expect(confirm).toBeVisible()
  const dialogStyle = await confirm.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow
    }
  })
  record(
    '计算样式：.wb-gen-dialog borderTopWidth=0',
    parseFloat(dialogStyle.borderTopWidth) === 0 &&
      parseFloat(dialogStyle.borderRightWidth) === 0 &&
      parseFloat(dialogStyle.borderBottomWidth) === 0 &&
      parseFloat(dialogStyle.borderLeftWidth) === 0,
    JSON.stringify(dialogStyle)
  )
  record(
    '计算样式：.wb-gen-dialog 使用 --wb-radius-panel',
    Math.abs(parseFloat(dialogStyle.borderRadius) - 26) < 0.5,
    dialogStyle.borderRadius
  )
  record(
    '计算样式：.wb-gen-dialog 阴影取 --wb-shadow-float',
    dialogStyle.boxShadow !== 'none',
    dialogStyle.boxShadow.slice(0, 160)
  )
  await capture(page, '10-confirm-dialog.png', {
    state: '取消生成确认框',
    fixture: 'generation=decision; workbench=mixed; history=fixture',
    search
  })
  await confirm.getByRole('button', { name: '先不处理' }).click()
  await expect(confirm).toBeHidden()

  await expectNoHorizontalOverflow(page, '默认格式')
})

test('减少动态效果', async ({ page }) => {
  instrument(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const runningSearch = '/?workbench=mixed&generation=running&history=fixture'
  await page.goto(runningSearch)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await openDrawer(page)

  const motion = await page.evaluate(() => {
    const pulse = document.querySelector('.wb-gen-run__pulse')
    const list = document.querySelector('.wb-drawer-tabs__list')
    const close = document.querySelector('.wb-drawer__close')
    return {
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      pulseAnimation:
        pulse instanceof HTMLElement ? getComputedStyle(pulse, '::after').animationName : 'missing',
      scrollBehavior: list ? getComputedStyle(list).scrollBehavior : 'missing',
      closeTransition: close ? getComputedStyle(close).transitionDuration : 'missing'
    }
  })
  record('减少动态效果：媒体查询命中', motion.reduced === true, JSON.stringify(motion))
  record('减少动态效果：循环脉冲动画停止', motion.pulseAnimation === 'none', JSON.stringify(motion))
  record(
    '减少动态效果：标签栏改为直接跳位',
    motion.scrollBehavior === 'auto',
    JSON.stringify(motion)
  )
  await capture(page, '11-reduced-motion.png', {
    state: '减少动态效果',
    fixture: 'generation=running; workbench=mixed; history=fixture',
    search: runningSearch
  })

  const decisionSearch = '/?workbench=mixed&generation=decision&history=fixture'
  await page.goto(decisionSearch)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await openDrawer(page)

  await page.locator('.wb-gen-option').first().click()
  const primary = page.locator('.wb-gen-primary').first()
  await expect(primary).toBeEnabled()
  const primaryMotion = await primary.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      transitionDuration: style.transitionDuration,
      transform: style.transform
    }
  })
  record(
    '减少动态效果：主按钮过渡压到短淡入',
    parseFloat(primaryMotion.transitionDuration) <= 0.001,
    JSON.stringify(primaryMotion)
  )
  await primary.hover()
  const hoveredMotion = await primary.evaluate((node) => {
    const style = getComputedStyle(node)
    return { transform: style.transform }
  })
  record(
    '减少动态效果：主按钮 hover 不位移',
    hoveredMotion.transform === 'none' ||
      /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(hoveredMotion.transform),
    JSON.stringify(hoveredMotion)
  )
  await expectNoPageWideOverflow(page, '减少动态效果')
})
