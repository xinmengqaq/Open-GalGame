import { defineConfig } from 'vitest/config'

import { rendererAliases } from './vite.renderer.config'

export default defineConfig({
  resolve: { alias: rendererAliases },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true
  }
})
