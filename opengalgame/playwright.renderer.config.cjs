const { defineConfig, devices } = require('@playwright/test')
const path = require('node:path')

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  testMatch: '{home,projects,projects-shots,workbench,workbench-history,review-fixes}.spec.cjs',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:5173/',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    ...devices['Desktop Chrome']
  },
  webServer: {
    command: 'npx vite --config vite.renderer.config.ts --open false',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    cwd: __dirname,
    env: { ...process.env, OPENGALGAME_BROWSER_FILES: 'fixture' }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
})
