const { chromium, expect } = require('@playwright/test')
const { build } = require('esbuild')
const { strict: assert } = require('node:assert')
const path = require('node:path')
const { before, after, beforeEach, afterEach, test } = require('node:test')

let browser
let page
let script
let stylesheet
let errors

before(async () => {
  const result = await build({
    absWorkingDir: path.resolve(__dirname, '../..'),
    stdin: {
      contents: `
        import './src/bootstrap/renderer';
        import gsap from 'gsap';
        import { useNavigationStore } from './src/presentation/stores/navigation.store';
        window.homeTest = { gsap, navigation: useNavigationStore };
      `,
      resolveDir: path.resolve(__dirname, '../..'),
      loader: 'tsx'
    },
    bundle: true,
    write: false,
    outfile: 'home-test.js',
    jsx: 'automatic',
    loader: { '.webp': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' }
  })
  script = result.outputFiles.find((file) => file.path.endsWith('.js')).text
  stylesheet = result.outputFiles.find((file) => file.path.endsWith('.css')).text
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
  await page.goto('http://127.0.0.1/')
  await page.addStyleTag({ content: stylesheet })
  await page.evaluate(() => {
    window.opengalgame = {
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
  await expect(page.getByRole('button', { name: '连接设置' })).toBeVisible()
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
  await page.getByRole('button', { name: '继续编辑' }).click()
  await expect(name).toHaveValue('Moonlight')
  await name.press('Escape')
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.getByRole('button', { name: '连接设置' }).click()
  const address = page.locator('#base-url')
  await address.click()
  await address.pressSequentially('https://example.com/v1', { delay: 25 })
  await expect(address).toHaveValue('https://example.com/v1')
  await expect(address).toBeFocused()
  await address.press('Escape')
  await expect(page.getByRole('button', { name: '连接设置' })).toBeFocused()
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
})

test('慢加载期间不可编辑，关闭重开后旧响应不能覆盖新草稿', async () => {
  await page.evaluate(() => {
    window.loads = []
    window.opengalgame.getSettingsSummary = () =>
      new Promise((resolve) => window.loads.push(resolve))
  })
  await mount()
  await page.getByRole('button', { name: '连接设置' }).click()
  await expect(page.getByText('正在读取连接设置…')).toBeVisible()
  await expect(page.locator('#base-url')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '连接设置' }).click()
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
    let count = 0
    window.opengalgame.getSettingsSummary = async () =>
      ++count === 1 ? { code: 5102, msg: '读取失败' } : { code: 2000, msg: 'ok', data: null }
  })
  await mount()
  await page.getByRole('button', { name: '连接设置' }).click()
  await expect(page.getByText('无法读取连接设置')).toBeVisible()
  await expect(page.getByText('读取失败', { exact: true })).toBeVisible()
  await expect(page.locator('#base-url')).toHaveCount(0)
  await page.getByRole('button', { name: '重新加载' }).click()
  await page.locator('#base-url').fill('discarded')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '连接设置' }).click()
  await expect(page.locator('#base-url')).toHaveValue('')
})

test('测试通过后保存新密钥，成功提示不被测试指纹隐藏', async () => {
  await mount()
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.locator('#model-id').fill('demo-chat')
  await page.locator('#api-key').fill('test-key')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByText('测试通过', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('#api-key')).toHaveValue('')
  await expect(page.getByText('设置已保存')).toBeVisible()
})

test('修改草稿使测试结果失效，但不隐藏之后的模型列表结果', async () => {
  await mount()
  await page.getByRole('button', { name: '连接设置' }).click()
  await page.locator('#model-id').fill('demo-chat')
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByText('测试通过', { exact: true })).toBeVisible()
  await page.locator('#base-url').fill('https://new.example/v1')
  await expect(page.getByText('测试通过', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '拉取列表' }).click()
  await expect(page.getByText('已拉取 1 个模型')).toBeVisible()
  await expect(page.locator('#model-id')).toHaveAttribute('role', 'combobox')
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
  await expect(page.getByRole('heading', { name: '项目选择' })).toBeVisible()
  assert.equal(await pointerListeners(), 0)
  assert.equal(await loopingAnimations(), 0)
  await page.getByRole('button', { name: '返回首页' }).click()
  await expect(page.getByRole('button', { name: '连接设置' })).toBeVisible()
  assert.equal(await loopingAnimations(), 2)
  await session.detach()
})
