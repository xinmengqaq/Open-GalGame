const { app, BrowserWindow, dialog } = require('electron')
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, readdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const workspaceRoot = join(__dirname, '..', '..', '..')
const projectDir = join(workspaceRoot, '空白画布')
const data = join(tmpdir(), 'opengalgame-create-root')
const userDirectory = join(data, '.opengalgame')
mkdirSync(data, { recursive: true })
if (!existsSync(projectDir)) mkdirSync(projectDir)
assert.equal(
  existsSync(join(projectDir, '.opengalgame')),
  false,
  '目标目录已有工程，请换一个空目录'
)

app.setPath('userData', data)
app.disableHardwareAcceleration()
const timeout = setTimeout(() => {
  process.stderr.write('创建根目录项目超时\n')
  app.exit(1)
}, 30000)

app
  .whenReady()
  .then(async () => {
    const { createHomeBackend } = require('../../out/qa/home.cjs')
    const rendererPath = join(__dirname, '../../out/renderer/index.html')
    dialog.showOpenDialog = async (_window, options) => {
      assert.ok(options.properties.includes('openDirectory'))
      assert.ok(options.properties.includes('createDirectory'))
      assert.equal(options.title, '选择保存位置')
      return { canceled: false, filePaths: [projectDir] }
    }
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../../out/preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    await window.loadFile(rendererPath)
    const close = await createHomeBackend({
      getWindow: () => window,
      rendererUrl: window.webContents.getURL() || pathToFileURL(rendererPath).href,
      userDirectory
    })
    const call = (source) => window.webContents.executeJavaScript(source)

    const chosen = await call('window.opengalgame.chooseSaveLocation()')
    assert.equal(chosen.code, 2000, chosen.msg)
    assert.ok(chosen.data && chosen.data.directory)

    const result = await call(`(async () => {
      const progress = []
      const off = window.opengalgame.onProjectProgress(value => progress.push(value))
      const response = await window.opengalgame.createProject({
        operationId: 'root-create',
        name: '空白画布'
      })
      off()
      return { response, progress }
    })()`)
    assert.equal(result.response.code, 2000, result.response.msg)
    assert.equal(result.response.data.status, 'completed')
    assert.equal(result.response.data.name, '空白画布')
    assert.equal(result.progress.at(-1).stage, 'completed')
    assert.ok(!JSON.stringify(result).includes(projectDir))

    const manifest = JSON.parse(
      readFileSync(join(projectDir, '.opengalgame', 'manifest.json'), 'utf8')
    )
    assert.equal(manifest.projectId, result.response.data.projectId)
    const managed = readdirSync(join(projectDir, '.opengalgame')).sort()
    assert.deepEqual(managed, ['manifest.json', 'project.json'])
    assert.ok(existsSync(join(projectDir, 'assets')))
    assert.ok(existsSync(join(userDirectory, 'projects.json')))

    window.destroy()
    await close()
    clearTimeout(timeout)
    process.stdout.write(`已通过接口创建：${projectDir}\n项目 id：${manifest.projectId}\n`)
    app.quit()
  })
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    clearTimeout(timeout)
    app.exit(1)
  })
