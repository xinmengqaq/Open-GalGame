const { test, expect } = require('@playwright/test')
const { execFileSync, spawn } = require('node:child_process')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const net = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const appRoot = resolve(__dirname, '..', '..')
const evidenceDir = join(appRoot, 'artifacts', 'scene-export-r25')
const projectId = 'p-r25'
const sceneId = 'scene-1'
const savedRequestId = 'request-saved-r25'
const contentBasis = {
  digest: 'content-digest-r25',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}
const savedVersion = {
  requestId: savedRequestId,
  revisionDigest: 'a'.repeat(64),
  contentBasis
}
const openDirectoryFailureNote = '无法打开文件夹，请手动打开上面的路径'

/**
 * R25「打开所在文件夹」页面回归。
 *
 * 真实装配：隔离临时用户目录 + real 模式 Vite + 真实工程，不使用产品夹具冒充导出。
 * 只断言用户可见行为：进行中/禁用、失败内联提示、收起后不复活、目录与提示一致。
 *
 * 明确边界：
 * - 成功路径在 dev 调用边界截断 `openDirectory` 响应，不启动资源管理器，
 *   不声称真实 OS 打开成功。
 * - 失败路径把导出目录指向不存在的路径，让真实 system-path 校验在系统打开前拒绝。
 * - 取消/收起：产品没有取消打开动作；用户可在进行中收起提示，
 *   请求继续，迟到结果不得回填到已收起的提示。
 * - 导出/最近保存的 dev 响应只用于稳定构造成功提示，不验证 Windows 打包。
 */
const screenViewport = (() => {
  if (process.platform !== 'win32') return null
  try {
    const raw = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($a.Width)x$($a.Height)"'
      ],
      { encoding: 'utf8' }
    ).trim()
    const [width, height] = raw.split('x').map(Number)
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
})()

test.use({ viewport: screenViewport })
test.describe.configure({ mode: 'serial' })
test.setTimeout(120000)

let world
let baseUrl
const children = new Set()

async function seedWorld() {
  const root = await mkdtemp(join(tmpdir(), 'scene-export-r25-'))
  const userDirectory = join(root, 'userhome')
  const projectRoot = join(root, 'project')
  const exportDirectory = join(root, 'exports', 'scene-output')
  const missingDirectory = join(root, 'exports', 'missing-scene-output')

  await mkdir(userDirectory, { recursive: true })
  await mkdir(exportDirectory, { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await mkdir(join(projectRoot, 'game', 'scene'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame', 'project.json'),
    JSON.stringify({ id: projectId, name: '导出目录回归工程', synopsis: '' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId, operationId: 'op-register' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'scene-locks.json'),
    JSON.stringify({ scenes: [{ sceneId, lockState: 'unlocked' }] })
  )
  await writeFile(join(projectRoot, 'game', 'scene', 'start.txt'), '旁白:导出目录回归;\n')
  await writeFile(
    join(userDirectory, 'projects.json'),
    JSON.stringify({
      registrations: [{ id: projectId, directory: projectRoot, operationId: 'op-register' }]
    })
  )

  execFileSync('git', ['init'], { cwd: projectRoot })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: projectRoot })
  execFileSync('git', ['add', '-A'], { cwd: projectRoot })
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: projectRoot })

  return { root, userDirectory, projectRoot, exportDirectory, missingDirectory }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Vite 未在 ${timeoutMs}ms 内就绪: ${lastError ?? 'timeout'}`)
}

async function startServer() {
  world = await seedWorld()
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}/`
  const env = { ...process.env }
  delete env.OPENGALGAME_BROWSER_FILES
  env.OPENGALGAME_DEV_USER_DIRECTORY = world.userDirectory
  const child = spawn(
    process.execPath,
    [
      join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      'vite.renderer.config.ts',
      '--port',
      String(port)
    ],
    { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  children.add(child)
  try {
    await waitForHttp(baseUrl, 60000)
  } catch (error) {
    throw new Error(`${error.message}\n${output.slice(-2000)}`)
  }
}

async function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null) continue
    child.kill()
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 3000))
    ])
    if (child.exitCode === null) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } catch {
        // 进程已经退出。
      }
    }
  }
  children.clear()
}

async function openWorkbench(page) {
  await page.goto(baseUrl)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 30000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('workbench-screen')).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('scene-canvas')).toBeVisible({ timeout: 30000 })
}

function devCallOf(request) {
  try {
    const payload = request.postDataJSON()
    return typeof payload === 'object' && payload !== null ? payload : null
  } catch {
    return null
  }
}

function isDevCall(request, method) {
  return devCallOf(request)?.method === method
}

function latestSaveResult() {
  return {
    code: 2000,
    msg: '最近预览保存已读取',
    data: savedVersion
  }
}

function exportResult(directoryPath) {
  return {
    code: 2000,
    msg: '场景导出已返回',
    data: {
      status: 'succeeded',
      artifact: {
        executableName: 'WebGAL.exe',
        directoryName: 'scene-output',
        directoryPath,
        bytes: 2_621_440,
        containsFixedEngine: true,
        entryRelativePath: 'game/scene/start.txt',
        contentBasis,
        versionReference: { kind: 'preview-save', requestId: savedRequestId }
      }
    }
  }
}

function openDirectorySuccess() {
  return { code: 2000, msg: '目录已交给系统打开', data: null }
}

async function fulfillJson(route, payload) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload)
  })
}

async function writeEvidence(name, payload) {
  await writeFile(join(evidenceDir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`)
}

function exportButton(page) {
  return page.locator('[data-action="export"]')
}

function exportNotice(page) {
  return page.getByRole('status').filter({ hasText: '已导出' })
}

/** 按钮文案在打开中会变成「正在打开…」，用两种状态共用同一 locator。 */
function openDirectoryButton(notice) {
  return notice.getByRole('button', { name: /打开所在文件夹|正在打开…/ })
}

/** 只铺设页面装载与导出提示所需的三类 dev 调用；其余请求交给真实 dev backend。 */
async function installExportRoutes(page, directoryPath, onOpenDirectory) {
  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestPreviewSave') {
      return fulfillJson(route, latestSaveResult())
    }
    if (payload.method === 'exportSavedScene') {
      return fulfillJson(route, exportResult(directoryPath))
    }
    if (payload.method === 'openDirectory') {
      return onOpenDirectory(route, payload.input)
    }
    return route.continue()
  })
}

/** 导出成功提示是打开目录的唯一入口；这里只构造提示，不验证导出本身。 */
async function openExportedScene(page, directoryPath = world.exportDirectory) {
  await expect(exportButton(page)).toBeEnabled({ timeout: 30000 })
  await exportButton(page).click()
  const notice = exportNotice(page)
  await expect(notice).toBeVisible({ timeout: 15000 })
  await expect(notice).toContainText('已导出到：')
  await expect(notice).toContainText(directoryPath)
  await expect(notice).toHaveAttribute('title', '已生成 WebGAL.exe（2.5 MB）')
  return notice
}

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true })
  await startServer()
})

test.afterAll(async () => {
  await stopChildren()
  if (world) await rm(world.root, { recursive: true, force: true })
})

test('打开所在文件夹时显示进行中并禁用重复操作，成功后恢复', async ({ page }) => {
  const openRequests = []
  let releaseOpen
  const openGate = new Promise((resolveGate) => {
    releaseOpen = resolveGate
  })

  await installExportRoutes(page, world.exportDirectory, async (route, input) => {
    openRequests.push(input)
    /* 明确截断系统边界：不启动资源管理器，只验证页面消费者。 */
    await openGate
    await fulfillJson(route, openDirectorySuccess())
  })
  await openWorkbench(page)

  const notice = await openExportedScene(page)
  const openButton = openDirectoryButton(notice)
  await openButton.click()
  await expect(notice.getByText('正在打开…')).toBeVisible()
  await expect(openButton).toBeDisabled()
  await expect(openButton).toHaveAttribute('aria-busy', 'true')

  /* 禁用状态下再点一次不产生第二次目录请求。 */
  await openButton.evaluate((button) => button.click())
  await page.screenshot({ path: join(evidenceDir, 'open-directory-opening.png') })

  releaseOpen()
  await expect(openButton).toBeEnabled()
  await expect(notice.getByText('正在打开…')).toHaveCount(0)
  await expect(notice.getByRole('alert')).toHaveCount(0)
  await expect(notice).toContainText(world.exportDirectory)
  expect(openRequests).toEqual([{ path: world.exportDirectory }])
  await page.screenshot({ path: join(evidenceDir, 'open-directory-success.png') })

  await writeEvidence('open-directory-success', {
    viewport: page.viewportSize(),
    boundary: '成功路径截断 openDirectory 的 dev 调用；真实资源管理器未启动。',
    directoryPath: world.exportDirectory,
    openRequests: openRequests.length,
    pendingState: { label: '正在打开…', disabled: true, busy: true },
    settledState: { alertVisible: false, buttonEnabled: true }
  })
})

test('目录不存在时保留导出结果并显示内联失败提示', async ({ page }) => {
  const openRequests = []

  await installExportRoutes(page, world.missingDirectory, async (route, input) => {
    openRequests.push(input)
    /* 继续走真实 dev backend：缺失目录在系统打开前被拒绝。 */
    return route.continue()
  })
  await openWorkbench(page)

  const notice = await openExportedScene(page, world.missingDirectory)
  const rejectedResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/__opengalgame/dev/call') &&
      isDevCall(response.request(), 'openDirectory')
  )

  await openDirectoryButton(notice).click()
  const rejected = await (await rejectedResponse).json()
  expect(rejected).toMatchObject({ code: 4701, msg: '只能打开本机已有的目录' })

  const alert = notice.getByRole('alert')
  await expect(alert).toHaveText(openDirectoryFailureNote)
  await expect(openDirectoryButton(notice)).toBeEnabled()
  await expect(notice).toContainText(world.missingDirectory)
  await expect(notice).toHaveAttribute('title', '已生成 WebGAL.exe（2.5 MB）')
  expect(openRequests).toEqual([{ path: world.missingDirectory }])
  await page.screenshot({ path: join(evidenceDir, 'open-directory-failure.png') })

  await writeEvidence('open-directory-failure', {
    viewport: page.viewportSize(),
    boundary: '缺失目录在 LocalDirectoryOpenGateway 校验阶段被拒绝，未到达系统打开。',
    directoryPath: world.missingDirectory,
    response: rejected,
    failureNote: openDirectoryFailureNote,
    noticePreserved: true,
    buttonEnabledAfterFailure: true
  })
})

test('打开进行中收起提示，迟到的失败不恢复旧结果', async ({ page }) => {
  let releaseOpen
  const openGate = new Promise((resolveGate) => {
    releaseOpen = resolveGate
  })

  await installExportRoutes(page, world.missingDirectory, async (route) => {
    await openGate
    /* 产品没有取消打开动作：收起提示后请求继续，由真实 system-path 返回失败。 */
    return route.continue()
  })
  await openWorkbench(page)

  const notice = await openExportedScene(page, world.missingDirectory)
  const rejectedResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/__opengalgame/dev/call') &&
      isDevCall(response.request(), 'openDirectory')
  )
  await openDirectoryButton(notice).click()
  await expect(notice.getByText('正在打开…')).toBeVisible()

  await notice.getByRole('button', { name: '收起导出结果' }).click()
  await expect(exportNotice(page)).toHaveCount(0)

  releaseOpen()
  const rejected = await (await rejectedResponse).json()
  expect(rejected).toMatchObject({ code: 4701, msg: '只能打开本机已有的目录' })
  await page.waitForTimeout(250)
  await expect(page.getByText('已导出到：')).toHaveCount(0)
  await expect(page.getByText(openDirectoryFailureNote)).toHaveCount(0)
  await expect(exportButton(page)).toBeEnabled()
  await page.screenshot({ path: join(evidenceDir, 'open-directory-cancelled.png') })

  await writeEvidence('open-directory-cancelled', {
    viewport: page.viewportSize(),
    boundary:
      '产品没有取消打开动作；用户收起提示后请求继续，真实 system-path 返回失败，迟到失败不回填。',
    response: rejected,
    noticeAfterDismiss: 0,
    failureNoteAfterSettle: 0,
    exportButtonEnabled: true
  })
})
