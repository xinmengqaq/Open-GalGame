import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import type { UserConfig } from 'vite'

import { browserDevFilesPlugin } from './src/bootstrap/browser/devFilePlugin'

const rendererRoot = resolve(__dirname, 'src/bootstrap')

/** Electron 与端到端夹具不挂真实文件后端；普通 Vite 开发服务默认挂上。 */
function browserFilesMode(): 'real' | 'fixture' {
  if (process.argv.some((arg) => arg.includes('electron-vite'))) return 'fixture'
  if (process.env.OPENGALGAME_BROWSER_FILES === 'fixture') return 'fixture'
  return 'real'
}

const browserFiles = browserFilesMode()

export const rendererAliases = {
  '@bootstrap': resolve(__dirname, 'src/bootstrap'),
  '@presentation': resolve(__dirname, 'src/presentation'),
  '@interfaces': resolve(__dirname, 'src/interfaces'),
  '@application': resolve(__dirname, 'src/application'),
  '@domain': resolve(__dirname, 'src/domain'),
  '@infrastructure': resolve(__dirname, 'src/infrastructure'),
  '@common': resolve(__dirname, 'src/common')
}

export const rendererConfig: UserConfig = {
  root: rendererRoot,
  publicDir: resolve(rendererRoot, 'public'),
  define: {
    'import.meta.env.VITE_OPENGALGAME_BROWSER_FILES': JSON.stringify(browserFiles)
  },
  plugins: [react(), tailwindcss(), ...(browserFiles === 'real' ? [browserDevFilesPlugin()] : [])],
  resolve: {
    alias: rendererAliases
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: true
  }
}

export default rendererConfig
