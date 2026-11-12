import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'path'
import type { UserConfig } from 'vite'

import { browserDevFilesPlugin } from './src/bootstrap/browser/devFilePlugin'

const rendererRoot = resolve(__dirname, 'src/bootstrap')

function readAppVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version
  }
  throw new Error('package.json version is missing')
}

export const appVersion = readAppVersion()

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
    'import.meta.env.VITE_OPENGALGAME_BROWSER_FILES': JSON.stringify(browserFiles),
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [react(), tailwindcss(), ...(browserFiles === 'real' ? [browserDevFilesPlugin()] : [])],
  resolve: {
    alias: rendererAliases,
    // md-blockkit 通过 file: 子模块链接，包内自带 node_modules/react；强制从应用根解析，避免打包后出现两份 React。
    dedupe: ['react', 'react-dom']
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: true
  }
}

export default rendererConfig
