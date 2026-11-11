const { defineConfig, devices } = require('@playwright/test')
const path = require('node:path')

const port = 5199
const baseURL = `http://127.0.0.1:${port}/`
const { deviceScaleFactor: _deviceScaleFactor, ...desktopChrome } = devices['Desktop Chrome']

/**
 * 生成抽屉的正式页面验收配置。
 *
 * 与 `playwright.renderer.config.cjs` 分开：这里不设固定视口，Chromium 以最大化
 * 窗口启动，`viewport: null` 让页面使用实际客户区；服务端固定使用 UI 夹具。
 */
module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  testMatch: 'workbench-generation.spec.cjs',
  timeout: 120000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...desktopChrome,
    baseURL,
    viewport: null,
    locale: 'zh-CN',
    headless: false,
    launchOptions: { args: ['--start-maximized'] },
    screenshot: 'off',
    trace: 'off',
    video: 'off'
  },
  webServer: {
    command: `npx vite --config vite.renderer.config.ts --host 127.0.0.1 --port ${port} --strictPort --open false`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
    cwd: __dirname,
    env: { ...process.env, OPENGALGAME_BROWSER_FILES: 'fixture' }
  },
  projects: [{ name: 'chromium-headed', use: { browserName: 'chromium' } }]
})
