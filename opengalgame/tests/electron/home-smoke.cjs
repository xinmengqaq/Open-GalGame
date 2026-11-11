const { app, BrowserWindow, dialog, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const root = mkdtempSync(join(tmpdir(), 'opengalgame-electron-'))
const data = join(root, 'app')
const userDirectory = join(root, '.opengalgame')
const workspace = join(root, '测试作品')
mkdirSync(data)
mkdirSync(workspace)
app.setPath('userData', data)
app.disableHardwareAcceleration()
const timeout = setTimeout(() => {
  process.stderr.write('Electron 验证超时\n')
  app.exit(1)
}, 30000)

app
  .whenReady()
  .then(async () => {
    const { createHomeBackend } = require('../../out/qa/home.cjs')
    const rendererPath = join(__dirname, '../../out/renderer/index.html')
    let window = null
    dialog.showOpenDialog = async (_window, options) => {
      assert.ok(options.properties.includes('openDirectory'))
      assert.ok(!options.properties.includes('openFile'))
      return { canceled: false, filePaths: [workspace] }
    }
    const close = await createHomeBackend({
      getWindow: () => window,
      rendererUrl: pathToFileURL(rendererPath).href,
      userDirectory
    })
    const windowOptions = {
      show: false,
      webPreferences: {
        preload: join(__dirname, '../../out/preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    }
    window = new BrowserWindow(windowOptions)
    await window.loadFile(rendererPath)
    const call = (source) => window.webContents.executeJavaScript(source)
    assert.equal(await call('typeof window.opengalgame.createProject'), 'function')
    assert.equal(await call('typeof window.opengalgame.chooseSaveLocation'), 'function')
    assert.equal(await call('typeof window.opengalgame.clearSaveLocation'), 'function')
    assert.equal((await call('window.opengalgame.getSettingsSummary()')).data, null)
    assert.equal(
      (
        await call(
          'window.opengalgame.createProject({ operationId: "bad", name: "n", directory: "C:/forbidden" })'
        )
      ).code,
      4101
    )
    const result = await call(`(async () => {
    const progress = []
    const off = window.opengalgame.onProjectProgress(value => progress.push(value))
    const response = await window.opengalgame.createProject({ operationId: 'electron-create', name: '桌面作品' })
    off()
    return { response, progress }
  })()`)
    assert.equal(result.response.code, 2000)
    assert.equal(result.progress.at(-1).stage, 'completed')
    const manifest = JSON.parse(readFileSync(join(workspace, '.opengalgame/manifest.json'), 'utf8'))
    assert.equal(manifest.projectId, result.response.data.projectId)
    assert.ok(!JSON.stringify(result).includes(workspace))
    assert.equal(
      (await call('window.opengalgame.importProject({ operationId: "duplicate" })')).code,
      1205
    )
    const foreign = new BrowserWindow(windowOptions)
    await foreign.loadFile(rendererPath)
    assert.equal(
      (await foreign.webContents.executeJavaScript('window.opengalgame.getSettingsSummary()')).code,
      4102
    )
    foreign.destroy()
    assert.ok(safeStorage.isEncryptionAvailable(), '系统安全存储不可用')
    const saved = await call(
      'window.opengalgame.saveSettings({providerId:"openai-compatible",baseUrl:"http://localhost:9999/v1",model:"smoke",contextWindow:8192,maxOutputTokens:1024,apiKey:{kind:"replace",value:"temporary-smoke-secret"}})'
    )
    assert.equal(saved.code, 2000)
    assert.equal(saved.data.hasApiKey, true)
    assert.ok(!JSON.stringify(saved).includes('temporary-smoke-secret'))
    window.destroy()
    await close()
    clearTimeout(timeout)
    process.stdout.write(
      `Electron ${process.versions.electron}：目录创建、工程文件、preload、IPC 来源隔离、系统密钥加密验证通过\n`
    )
    app.quit()
  })
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    clearTimeout(timeout)
    app.exit(1)
  })
