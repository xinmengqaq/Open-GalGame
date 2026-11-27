const { chromium, expect } = require('@playwright/test')
const { strict: assert } = require('node:assert')
const { before, after, beforeEach, afterEach, test } = require('node:test')

const { buildHomeTestBundle } = require('./support/build-home-test-bundle.cjs')
const { seedGuidePreference } = require('./support/guide-preference.cjs')
const {
  answerDiscardConfirm,
  openConnectionSettings,
  openSettings,
  selectSettingsSection,
  settingsEntry,
  discardConfirmDialog,
  APPEARANCE_SECTION,
  CONNECTION_SECTION
} = require('./support/settings-center.cjs')

let browser
let page
let script
let stylesheet
let errors

before(async () => {
  const bundle = await buildHomeTestBundle()
  script = bundle.script
  stylesheet = bundle.stylesheet
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
})

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('http://127.0.0.1/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="root"></div></body></html>'
    })
  )
  await seedGuidePreference(page)
  await page.goto('http://127.0.0.1/')
  await page.addStyleTag({ content: stylesheet })
  await page.evaluate(() => {
    const appUpdateUnavailable = () => ({ code: 5101, msg: '当前运行形态不支持应用内更新' })
    window.opengalgame = {
      readAppearance: async () => ({
        code: 2000,
        msg: 'ok',
        data: {
          fontPresetId: 'system',
          bodyTextSize: 15,
          glassOpacity: 70,
          highContrast: false,
          reducedMotion: 'system',
          themePreset: 'default',
          fontPresets: [
            {
              id: 'system',
              label: '系统字体',
              family: 'system-ui',
              fallback: 'system-ui, "Microsoft YaHei UI", sans-serif',
              bundled: false,
              roles: ['body', 'dialogue', 'title']
            }
          ]
        }
      }),
      saveAppearance: async (request) => ({
        code: 2000,
        msg: 'ok',
        data: {
          ...request,
          fontPresets: [
            {
              id: 'system',
              label: '系统字体',
              family: 'system-ui',
              fallback: 'system-ui, "Microsoft YaHei UI", sans-serif',
              bundled: false,
              roles: ['body', 'dialogue', 'title']
            }
          ]
        }
      }),
      getSettingsSummary: async () => ({ code: 2000, msg: 'ok', data: null }),
      testConnection: async () => ({ code: 2000, msg: 'ok', data: { available: true } }),
      saveSettings: async () => ({ code: 2000, msg: 'ok', data: { hasApiKey: true } }),
      listModels: async () => ({ code: 2000, msg: 'ok', data: { models: ['demo-chat'] } }),
      chooseSaveLocation: async () => ({
        code: 2000,
        msg: '已选择保存位置',
        data: { directory: 'D:\\games\\Moonlight' }
      }),
      clearSaveLocation: async () => ({ code: 2000, msg: 'ok', data: null }),
      readUpdateStatus: async () => ({
        code: 2000,
        msg: '更新状态已读取',
        data: { phase: 'idle', currentVersion: '0.1.0', supported: false }
      }),
      onAppUpdateStatus: () => () => {},
      checkForUpdate: async () => appUpdateUnavailable(),
      downloadUpdate: async () => appUpdateUnavailable(),
      installUpdate: async () => appUpdateUnavailable(),
      onProjectProgress: () => () => {}
    }
  })
})

afterEach(async () => {
  await page?.close()
  assert.deepEqual(errors, [])
})

async function mount() {
  await page.addScriptTag({ content: script })
  await expect(settingsEntry(page)).toBeVisible()
}

test('公共弹窗连续输入不丢焦点，Esc 和草稿确认仍正常', async () => {
  await mount()
  await page.getByRole('button', { name: '新建空白画布' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '新建空白画布' })).toBeFocused()
  await page.getByRole('button', { name: '新建空白画布' }).click()
  const name = page.locator('#project-name')
  await name.click()
  await name.pressSequentially('Moonlight', { delay: 25 })
  await expect(name).toHaveValue('Moonlight')
  await expect(name).toBeFocused()
  await name.press('Escape')
  await expect(page.getByText('有未提交的修改。要继续编辑，还是放弃修改？')).toBeVisible()
  await expect(page.getByRole('button', { name: '继续编辑' })).toBeFocused()
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(name).toHaveValue('Moonlight')
  await name.press('Escape')
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  const settings = await openConnectionSettings(page)
  const address = page.locator('#base-url')
  await address.click()
  await address.pressSequentially('https://example.com/v1', { delay: 25 })
  await expect(address).toHaveValue('https://example.com/v1')
  await expect(address).toBeFocused()
  await address.press('Escape')
  const discard = discardConfirmDialog(page)
  await expect(discard).toBeVisible()
  // 破坏性确认的默认焦点必须落在非破坏性动作上。
  await expect(discard.getByRole('button', { name: '继续编辑' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(discard).toBeHidden()
  await expect(settings).toBeVisible()
  await expect(address).toHaveValue('https://example.com/v1')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(discard).toBeVisible()
  await answerDiscardConfirm(page, '放弃并关闭')
  await expect(settings).toBeHidden()
  await expect(settingsEntry(page)).toBeFocused()
})

test('设置中心单入口、分区切换与草稿保留', async () => {
  await mount()
  await expect(page.getByRole('button', { name: /连接设置|应用设置/ })).toHaveCount(0)
  const settings = await openSettings(page)
  await expect(settings.getByRole('tab', { name: CONNECTION_SECTION })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await selectSettingsSection(page, APPEARANCE_SECTION)
  await expect(settings.getByRole('tabpanel')).toBeVisible()
  await selectSettingsSection(page, CONNECTION_SECTION)

  const address = page.locator('#base-url')
  await address.fill('https://draft.example/v1')
  await page.getByRole('tab', { name: APPEARANCE_SECTION }).click()
  const discard = discardConfirmDialog(page)
  await expect(discard).toBeVisible()
  await expect(discard.getByRole('button', { name: '继续编辑' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(discard).toBeHidden()
  await expect(settings.getByRole('tab', { name: CONNECTION_SECTION })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(address).toHaveValue('https://draft.example/v1')

  await page.getByRole('tab', { name: APPEARANCE_SECTION }).click()
  await expect(discard).toBeVisible()
  await expect(discard.getByRole('button', { name: '放弃并切换' })).toBeVisible()
  await answerDiscardConfirm(page, '放弃并切换')
  await expect(settings.getByRole('tab', { name: APPEARANCE_SECTION })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('登记失败重试保留原请求，失败不导航，成功才进入工作区', async () => {
  await page.evaluate(() => {
    window.requests = []
    window.opengalgame.createProject = async (request) => {
      window.requests.push(request)
      if (window.requests.length < 3) return { code: 1306, msg: '登记未完成，请重试原操作' }
      return new Promise((resolve) => {
        window.completeCreate = resolve
      })
    }
  })
  await mount()
  await page.getByRole('button', { name: '新建空白画布' }).click()
  await page.locator('#project-name').fill('Moonlight')
  await page.locator('#project-synopsis').fill('Original synopsis')
  await page.getByRole('button', { name: '选择文件夹' }).click()
  await page.getByRole('button', { name: '创建项目', exact: true }).click()
  await page.getByRole('button', { name: '重试登记' }).click()
  await expect(page.getByText('工程已保存，登记未完成')).toBeVisible()
  await expect(page.getByRole('heading', { name: '工作区' })).toHaveCount(0)
  await page.getByRole('button', { name: '重试登记' }).click()
  await expect(page.getByRole('button', { name: '正在创建…' })).toBeDisabled()
  const requests = await page.evaluate(() => window.requests)
  assert.equal(requests.length, 3)
  assert.ok(requests[0].operationId)
  assert.deepEqual(requests[1], requests[0])
  assert.deepEqual(requests[2], requests[0])
  await page.evaluate(() =>
    window.completeCreate({
      code: 2000,
      msg: 'ok',
      data: { status: 'completed', projectId: 'created', name: 'Moonlight' }
    })
  )
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible()
  await expect(page.getByText('项目已创建')).toBeVisible()
  const createdToast = page.locator('[data-sonner-toast]').filter({ hasText: '项目已创建' })
  const closeCreated = createdToast.getByRole('button', { name: '关闭通知' })
  await expect(closeCreated).toBeVisible()
  await closeCreated.click()
  await expect(createdToast).toHaveCount(0)
})

test('慢加载期间不可编辑，关闭重开后旧响应不能覆盖新草稿', async () => {
  await page.evaluate(() => {
    window.loads = []
    let calls = 0
    window.opengalgame.getSettingsSummary = () => {
      calls += 1
      // 奇数次是首页「设置」入口的模型配置探测，偶数是模型连接分区加载。
      if (calls % 2 === 1) return Promise.resolve({ code: 2000, msg: 'ok', data: null })
      return new Promise((resolve) => window.loads.push(resolve))
    }
  })
  await mount()
  const settings = await openConnectionSettings(page)
  await expect(settings.getByRole('status', { name: '正在读取已保存的连接设置' })).toBeVisible()
  await expect(page.locator('#base-url')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await openConnectionSettings(page)
  await page.evaluate(() => window.loads[1]({ code: 2000, msg: 'ok', data: null }))
  await page.locator('#base-url').fill('https://new.example/v1')
  await page.evaluate(() =>
    window.loads[0]({
      code: 2000,
      msg: 'ok',
      data: {
        providerId: 'anthropic',
        baseUrl: 'https://old.example',
        model: 'old',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        hasApiKey: true
      }
    })
  )
  await expect(page.locator('#base-url')).toHaveValue('https://new.example/v1')
  await expect(page.locator('#provider-id')).toHaveText('OpenAI 兼容')
})

test('配置加载失败明确提示并可重试，无已存配置不继承放弃的草稿', async () => {
  await page.evaluate(() => {
    let calls = 0
    window.opengalgame.getSettingsSummary = async () => {
      calls += 1
      // 第 1 次是首页入口探测，第 2 次是模型连接分区加载；只让分区加载失败。
      if (calls === 2) return { code: 5102, msg: '读取失败' }
      return { code: 2000, msg: 'ok', data: null }
    }
  })
  await mount()
  const settings = await openConnectionSettings(page)
  // 失败提示可落在分区内或副层弹窗；按新安全文案语义断言，保留重试结果。
  await expect(page.getByText(/连接设置.*无法读取|无法读取.*连接设置/).first()).toBeVisible()
  await expect(page.getByText(/检查文件是否损坏或被占用/).first()).toBeVisible()
  await page.getByRole('button', { name: '重新读取' }).click()
  await expect(page.locator('#base-url')).toBeVisible()
  await page.locator('#base-url').fill('discarded')
  await page.keyboard.press('Escape')
  await expect(discardConfirmDialog(page)).toBeVisible()
  await answerDiscardConfirm(page, '放弃并关闭')
  await expect(settings).toBeHidden()
  await openConnectionSettings(page)
  await expect(page.locator('#base-url')).toHaveValue('')
})

test('测试通过后保存新密钥，请求与成功提示不被测试指纹隐藏', async () => {
  await page.evaluate(() => {
    window.connectionRequests = { test: [], save: [] }
    window.opengalgame.testConnection = async (request) => {
      window.connectionRequests.test.push(request)
      return { code: 2000, msg: 'ok', data: { available: true } }
    }
    window.opengalgame.saveSettings = async (request) => {
      window.connectionRequests.save.push(request)
      return {
        code: 2000,
        msg: 'ok',
        data: {
          providerId: request.providerId,
          baseUrl: request.baseUrl,
          model: request.model,
          contextWindow: request.contextWindow,
          maxOutputTokens: request.maxOutputTokens,
          hasApiKey: true,
          hasExtension: false
        }
      }
    }
  })
  await mount()
  const settings = await openConnectionSettings(page)
  await page.locator('#model-id').fill('demo-chat')
  await page.locator('#api-key').fill('test-key')
  await page.getByRole('button', { name: '测试连接' }).click()
  const testToast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(testToast).toContainText('测试通过')
  await page.locator('#api-key').fill('new-key')
  await expect(testToast).toHaveCount(0)
  const notifications = page.getByRole('region', { name: /Notifications/ })
  await expect(notifications.locator('[data-sonner-toast]')).toHaveCount(0)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(settings).toBeVisible()
  await expect(notifications.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(1)
  const successToast = notifications.locator('[data-sonner-toast][data-type="success"]').first()
  const closeSuccess = successToast.getByRole('button', { name: '关闭通知' })
  await expect(closeSuccess).toBeVisible()
  await closeSuccess.click()
  await expect(successToast).toHaveCount(0)
  const requests = await page.evaluate(() => window.connectionRequests)
  assert.equal(requests.test.length, 1)
  assert.equal(requests.save.length, 1)
  assert.deepEqual(requests.test[0].apiKey, { kind: 'replace', value: 'test-key' })
  assert.deepEqual(requests.save[0].apiKey, { kind: 'replace', value: 'new-key' })
  assert.equal(requests.save[0].model, 'demo-chat')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()
  await openConnectionSettings(page)
  await expect(page.locator('#api-key')).toBeVisible()
  await expect(page.locator('#api-key')).toHaveValue('')
})

test('修改草稿使测试结果失效，但不隐藏之后的模型列表结果', async () => {
  await mount()
  await openConnectionSettings(page)
  await page.locator('#model-id').fill('demo-chat')
  await page.getByRole('button', { name: '测试连接' }).click()
  const testToast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(testToast).toContainText('测试通过')
  await page.locator('#base-url').fill('https://new.example/v1')
  await expect(testToast).toHaveCount(0)
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText(
    '已拉取 1 个模型'
  )
  await expect(page.locator('#model-id')).toHaveAttribute('role', 'combobox')
  await page.locator('#model-id').click()
  const listbox = page.getByRole('listbox')
  await expect(listbox.getByRole('option')).toHaveCount(1)
})

test('连接失败在应用右上角通知显示安全分类，关闭后不恢复', async () => {
  await page.evaluate(() => {
    window.opengalgame.testConnection = async () => ({
      code: 1407,
      msg: '模型服务未返回有效结果',
      reason: 'providerHttpStatus400'
    })
  })
  await mount()
  const settings = await openConnectionSettings(page)
  await expect(settings).toBeVisible()
  await page.getByRole('button', { name: '测试连接' }).click()
  const toast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('连接测试未通过')
  await expect(toast).toContainText('模型服务未返回有效结果')
  await expect(toast).toContainText('模型服务未返回有效结果（上游拒绝了测试请求）')
  await expect(toast).toContainText('按供应商要求检查扩展 JSON 的 defaultHeaders、模型和请求参数。')
  await expect(settings.getByText('上次操作')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '查看', exact: true })).toHaveCount(0)
  // 帮助按钮也带 data-tone=neutral；只按连接分区内可见的失败状态文案断言。
  const connectionPanel = settings.locator('#settings-panel-connection')
  await expect(connectionPanel.getByText('连接测试未通过')).toHaveCount(0)
  await expect(connectionPanel.getByText('模型服务未返回有效结果')).toHaveCount(0)

  await page.waitForTimeout(600)
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]')
    const title = dialog?.querySelector('h2')
    const toast = document.querySelector('[data-sonner-toast][data-type="error"]')
    const toaster = document.querySelector('[data-sonner-toaster]')
    const guide = document.querySelector('[data-guide-overlay="expanded"]')
    const rectOf = (node) => {
      if (!node) return null
      const { left, top, right, bottom } = node.getBoundingClientRect()
      return { left, top, right, bottom }
    }
    const overlaps = (a, b) =>
      Boolean(
        a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      )
    const toastRect = rectOf(toast)
    return {
      inTopLayerDialog: dialog.contains(toast),
      position: getComputedStyle(toaster).position,
      overlapsTitle: overlaps(toastRect, rectOf(title)),
      overlapsGuide: overlaps(toastRect, rectOf(guide)),
      rightSide: toastRect !== null && toastRect.left >= window.innerWidth / 2,
      topSide: toastRect !== null && toastRect.top >= 0 && toastRect.top <= window.innerHeight / 4
    }
  })
  assert.equal(layout.inTopLayerDialog, true)
  assert.equal(layout.position, 'fixed')
  assert.equal(layout.overlapsTitle, false, JSON.stringify(layout))
  assert.equal(layout.overlapsGuide, false)
  assert.equal(layout.rightSide, true)
  assert.equal(layout.topSide, true)

  await toast.getByRole('button', { name: '关闭通知' }).click()
  await expect(toast).toHaveCount(0)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()
  await openConnectionSettings(page)
  await expect(settings).toBeVisible()
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible()
})

test('全局浮层用成功/错误色区分，400 附带可执行提示', async () => {
  await page.evaluate(() => {
    window.opengalgame.testConnection = async () => ({
      code: 2000,
      msg: 'ok',
      data: { available: true }
    })
  })
  await mount()
  await openConnectionSettings(page)
  await page.getByRole('button', { name: '测试连接' }).click()
  const successToast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(successToast).toContainText('测试通过')
  const successStyle = await successToast.evaluate((node) => {
    const style = getComputedStyle(node)
    const description = node.querySelector('[data-description]')
    return {
      background: style.backgroundColor,
      borderLeft: style.borderLeftColor,
      color: style.color,
      description: description ? getComputedStyle(description).color : null
    }
  })

  await page.evaluate(() => {
    window.opengalgame.testConnection = async () => ({
      code: 1407,
      msg: '模型服务未返回有效结果',
      reason: 'providerHttpStatus400'
    })
  })
  await page.getByRole('button', { name: '测试连接' }).click()
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(errorToast).toContainText('按供应商要求检查扩展 JSON 的 defaultHeaders')
  const errorStyle = await errorToast.evaluate((node) => {
    const style = getComputedStyle(node)
    const description = node.querySelector('[data-description]')
    return {
      background: style.backgroundColor,
      borderLeft: style.borderLeftColor,
      color: style.color,
      description: description ? getComputedStyle(description).color : null
    }
  })

  assert.notEqual(successStyle.background, errorStyle.background)
  assert.notEqual(successStyle.borderLeft, errorStyle.borderLeft)
  assert.notEqual(successStyle.color, errorStyle.color)
  assert.notEqual(successStyle.description, errorStyle.description)
  await errorToast.getByRole('button', { name: '关闭通知' }).click()
  await expect(errorToast).toHaveCount(0)
})

test('无 reason 和未知 reason 只显示固定安全分类', async () => {
  await page.evaluate(() => {
    window.opengalgame.testConnection = async () => ({ code: 1404, msg: '连接测试超时' })
  })
  await mount()
  await openConnectionSettings(page)
  await page.getByRole('button', { name: '测试连接' }).click()
  const toast = page.locator('[data-sonner-toast][data-type="error"]')
  await expect(toast).toBeVisible()
  await expect(toast).not.toContainText('provider')
  await expect(toast).toContainText('连接测试超时（请求超时）')
  await expect(toast).toContainText('检查上游地址和网络后重新测试。')

  await page.evaluate(() => {
    window.opengalgame.testConnection = async () => ({
      code: 1407,
      msg: '模型服务未返回有效结果',
      reason: 'raw-provider-secret'
    })
  })
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('模型服务未返回有效结果（上游响应未通过校验）')
  await expect(toast).not.toContainText('raw-provider-secret')
})

test('入场完成不重复安装交互，离开首页清理视差监听和循环动画', async () => {
  await mount()
  await page.waitForFunction(() => window.homeTest.navigation.getState().hasPlayedHomeIntro)
  await page.evaluate(() => {
    window.previousHome = document.querySelector('section[aria-label="首页"]')
  })
  const session = await page.context().newCDPSession(page)
  const { result } = await session.send('Runtime.evaluate', { expression: 'window.previousHome' })
  async function pointerListeners() {
    const { listeners } = await session.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId
    })
    return listeners.filter((listener) => listener.type === 'pointermove').length
  }
  async function loopingAnimations() {
    return page.evaluate(
      () =>
        window.homeTest.gsap.globalTimeline.getChildren().filter((tween) => tween.repeat() === -1)
          .length
    )
  }
  assert.equal(await pointerListeners(), 1)
  assert.equal(await loopingAnimations(), 2)
  await page.getByRole('button', { name: '项目选择', exact: true }).click()
  await page.waitForFunction(() => !window.previousHome.isConnected)
  await page.waitForFunction(
    () =>
      window.homeTest.gsap.globalTimeline.getChildren().filter((tween) => tween.repeat() === -1)
        .length === 0
  )
  assert.equal(await pointerListeners(), 0)
  assert.equal(await loopingAnimations(), 0)
  await page.evaluate(() => window.homeTest.navigation.getState().visit('home'))
  await page.waitForFunction(() => window.homeTest.navigation.getState().page === 'home')
  await page.waitForFunction(
    () =>
      window.homeTest.gsap.globalTimeline.getChildren().filter((tween) => tween.repeat() === -1)
        .length === 2
  )
  assert.equal(await loopingAnimations(), 2)
  await session.detach()
})
