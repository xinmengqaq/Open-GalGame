import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

import { rendererAliases, rendererConfig } from './vite.renderer.config'

const rendererRoot = resolve(__dirname, 'src/bootstrap')

export default defineConfig({
  main: {
    resolve: { alias: rendererAliases },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/bootstrap/main.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: rendererAliases },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/bootstrap/preload.ts')
        }
      }
    }
  },
  renderer: {
    ...rendererConfig,
    root: rendererRoot,
    build: {
      ...rendererConfig.build,
      rollupOptions: {
        ...rendererConfig.build?.rollupOptions,
        input: {
          index: resolve(rendererRoot, 'index.html')
        }
      }
    }
  }
})
