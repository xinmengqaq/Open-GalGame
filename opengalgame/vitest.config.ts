import { defineConfig } from 'vitest/config'

import { appVersion, rendererAliases } from './vite.renderer.config'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  resolve: { alias: rendererAliases },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true
  }
})
