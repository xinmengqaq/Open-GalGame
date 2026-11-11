import { app, BrowserWindow, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'path'

import icon from '../../resources/icon.png?asset'
import { createHomeBackend } from './home'
import { isSameDocumentUrl } from '@interfaces/ipc/isSameDocumentUrl'

let mainWindow: BrowserWindow | null = null
let closeBackend: (() => Promise<void>) | undefined
let shuttingDown = false
const rendererUrl =
  !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** 建立主窗口，配置安全偏好并拦截外部链接与跨文档跳转。 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'opengalgame',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameDocumentUrl(url, rendererUrl)) event.preventDefault()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('xyz.opengalgame.app')
      closeBackend = await createHomeBackend({ getWindow: () => mainWindow, rendererUrl })
      createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })
    .catch((error: unknown) => {
      process.stderr.write(`应用后台启动失败，请检查配置与本地存储\n${String(error)}\n`)
      if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`)
      app.exit(1)
    })

app.on('second-instance', () => {
  mainWindow?.show()
  mainWindow?.focus()
})
app.on('before-quit', (event) => {
  if (shuttingDown || !closeBackend) return
  event.preventDefault()
  shuttingDown = true
  void closeBackend().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
