const { defineConfig } = require('@playwright/test')
const path = require('node:path')

const prototypes = path.join(__dirname, '..', 'prototypes')

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  testMatch: 'prototype-home.spec.cjs',
  timeout: 20000,
  use: {
    baseURL: 'http://127.0.0.1:4173/home/',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN'
  },
  webServer: {
    command: 'python -m http.server 4173',
    cwd: prototypes,
    url: 'http://127.0.0.1:4173/home/index.html',
    reuseExistingServer: true
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
})
