const { test, expect } = require('@playwright/test')
const { execFileSync, spawn } = require('node:child_process')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const net = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { seedGuidePreference } = require('./support/guide-preference.cjs')

const appRoot = resolve(__dirname, '..', '..')
const evidenceDir = process.env.OPENGALGAME_SCENE_EXPORT_EVIDENCE_DIR
  ? resolve(process.env.OPENGALGAME_SCENE_EXPORT_EVIDENCE_DIR)
  : join(appRoot, 'artifacts', 'scene-export-r25')
const projectId = 'p-r25'
const sceneId = 'scene-1'
const savedRequestId = 'request-saved-r25'
const contentBasis = {
  digest: 'content-digest-r25',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}
const savedVersion = {
  versionReference: { kind: 'preview-save', requestId: savedRequestId },
  revisionDigest: 'a'.repeat(64),
  contentBasis
}
const selectionId = '00000000-0000-4000-8000-000000000000'
const completedStatus = {
  projectId,
  sceneId,
  operationId: 'fixture-operation',
  threadId: 'fixture-thread',
  branchId: 'fixture-branch',
  checkpointId: 'fixture-checkpoint',
  state: 'succeeded',
  stage: 'completed',
  stageMessage: '场景生成已完成',
  attempt: 0,
  sequence: 3,
  canPause: false,
  canResume: false,
  canCancel: false,
  inputSummary: {
    canvasId: 'fixture-canvas',
    arrangementVersion: '1',
    documentCount: 0,
    assetCount: 0,
    promptCount: 0,
    fieldBindingCount: 0,
    relationCount: 0,
    confirmedControlCount: 0
  },
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenLimit: null },
  previewAvailable: false,
  result: { commitId: 'fixture-commit' }
}
const historySummary = {
  projectId,
  sceneId,
  operationId: 'fixture-operation',
  threadId: 'fixture-thread',
  branchId: 'fixture-branch',
  checkpointId: 'fixture-checkpoint',
  boundary: 'committed',
  stage: 'completed',
  message: '场景生成已完成',
  createdAt: '2026-11-20T00:00:00.000Z'
}
const openDirectoryRequestedHint = '请到系统窗口中查看'
const openDirectoryFailureInstruction = '请手动打开上面的路径'
const openDirectoryUnsupportedInstruction = '请手动复制上面的路径'

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
      } catch {}
    }
  }
  children.clear()
}

async function openWorkbench(page) {
  await seedGuidePreference(page)
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
    msg: '最新可导出正式版本已返回',
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
  return page.getByTestId('scene-export-notice')
}

async function rectOf(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left
    }
  })
}

function expectSameRects(before, after, keys) {
  for (const key of keys) {
    for (const edge of ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']) {
      expect(Math.abs(after[key][edge] - before[key][edge]), `${key}.${edge}`).toBeLessThanOrEqual(
        0.5
      )
    }
  }
}

function overlaps(a, b) {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
}

/** 浮动提示只占用操作栏空白，不压住选项、选择按钮或底部操作按钮。 */
function assertHintClearsControls(measured) {
  for (const key of ['options', 'choose', 'cancel', 'confirm']) {
    expect(overlaps(measured.hint, measured[key]), `hint overlaps ${key}`).toBe(false)
  }
}

async function openExportDialog(page) {
  await expect(exportButton(page)).toBeEnabled({ timeout: 30000 })
  await exportButton(page).click()
  const dialog = page.getByRole('dialog', { name: '导出当前场景' })
  await expect(dialog).toBeVisible()
  return dialog
}

/** 从顶栏入口确认默认目的地；开始导出后弹窗关闭，状态条负责结果。 */
async function startDefaultExport(page) {
  const dialog = await openExportDialog(page)
  await expect(dialog.getByRole('radio', { name: /工程目录（默认）/u })).toBeChecked()
  await dialog.getByRole('button', { name: '开始导出' }).click()
  await expect(dialog).toBeHidden()
}

function openDirectoryButton(notice) {
  return notice.getByRole('button', { name: /打开所在文件夹|正在打开…|当前环境不能打开/ })
}

async function installExportRoutes(page, directoryPath, onOpenDirectory) {
  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestSavedSceneVersion') {
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

async function openExportedScene(page, directoryPath = world.exportDirectory) {
  await startDefaultExport(page)
  const notice = exportNotice(page)
  await expect(notice).toBeVisible({ timeout: 15000 })
  await expect(notice).toContainText('产物位置')
  await expect(notice).toContainText(directoryPath)
  await expect(notice).toHaveAttribute('title', '已生成 WebGAL.exe（2.5 MB）')
  await expect(page.locator('[data-testid="scene-export-notice"]')).toHaveCount(1)
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

  await openButton.evaluate((button) => button.click())
  await page.screenshot({ path: join(evidenceDir, 'open-directory-opening.png') })

  releaseOpen()
  await expect(openButton).toBeEnabled()
  await expect(notice.getByText('正在打开…')).toHaveCount(0)
  await expect(notice.getByRole('alert')).toHaveCount(0)
  await expect(notice.getByText(`目录已交给系统打开；${openDirectoryRequestedHint}`)).toBeVisible()
  await expect(notice).toContainText(world.exportDirectory)
  expect(openRequests).toEqual([{ path: world.exportDirectory }])
  await page.screenshot({ path: join(evidenceDir, 'open-directory-success.png') })

  await writeEvidence('open-directory-success', {
    viewport: page.viewportSize(),
    boundary:
      '成功路径截断 openDirectory 的 dev 调用；页面只显示请求已交给系统，不证明资源管理器窗口出现。',
    directoryPath: world.exportDirectory,
    openRequests: openRequests.length,
    pendingState: { label: '正在打开…', disabled: true, busy: true },
    settledState: {
      alertVisible: false,
      buttonEnabled: true,
      requestedFeedback: `目录已交给系统打开；${openDirectoryRequestedHint}`
    }
  })
})

test('目录不存在时保留导出结果并显示内联失败提示', async ({ page }) => {
  const openRequests = []

  await installExportRoutes(page, world.missingDirectory, async (route, input) => {
    openRequests.push(input)
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
  await expect(alert).toHaveText(`只能打开本机已有的目录；${openDirectoryFailureInstruction}`)
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
    failureNote: `只能打开本机已有的目录；${openDirectoryFailureInstruction}`,
    noticePreserved: true,
    buttonEnabledAfterFailure: true
  })
})

test('当前环境不能打开本机目录时给出明确说明并禁用打开动作', async ({ page }) => {
  const openRequests = []

  await installExportRoutes(page, world.exportDirectory, async (route, input) => {
    openRequests.push(input)
    return fulfillJson(route, { code: 4102, msg: '当前环境不能打开本机目录' })
  })
  await openWorkbench(page)

  const notice = await openExportedScene(page)
  const openButton = openDirectoryButton(notice)
  await openButton.click()

  await expect(
    notice.getByText(`当前环境不能打开本机目录；${openDirectoryUnsupportedInstruction}`)
  ).toBeVisible()
  await expect(openButton).toBeDisabled()
  await expect(openButton).toContainText('当前环境不能打开')
  await expect(notice).not.toContainText('已交给系统打开')
  await expect(notice).toContainText(world.exportDirectory)
  expect(openRequests).toEqual([{ path: world.exportDirectory }])
  await page.screenshot({ path: join(evidenceDir, 'open-directory-unsupported.png') })

  await writeEvidence('open-directory-unsupported', {
    viewport: page.viewportSize(),
    boundary:
      '受控 403 响应对应夹具/无 dev 后端形态；真实 dev:web real 模式走 openDirectory 系统调用。',
    directoryPath: world.exportDirectory,
    response: { code: 4102, msg: '当前环境不能打开本机目录' },
    feedback: `当前环境不能打开本机目录；${openDirectoryUnsupportedInstruction}`,
    buttonDisabled: true,
    successClaimVisible: false
  })
})

test('打开进行中收起提示，迟到的失败不恢复旧结果', async ({ page }) => {
  let releaseOpen
  const openGate = new Promise((resolveGate) => {
    releaseOpen = resolveGate
  })

  await installExportRoutes(page, world.missingDirectory, async (route) => {
    await openGate
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
  await expect(page.getByText('产物位置')).toHaveCount(0)
  await expect(page.getByText(openDirectoryFailureInstruction)).toHaveCount(0)
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

test('取消导出弹窗不发送导出请求，也不显示结果', async ({ page }) => {
  const exportRequests = []
  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestSavedSceneVersion') {
      return fulfillJson(route, latestSaveResult())
    }
    if (payload.method === 'exportSavedScene') {
      exportRequests.push(payload.input)
      return fulfillJson(route, exportResult(world.exportDirectory))
    }
    return route.continue()
  })
  await openWorkbench(page)

  const dialog = await openExportDialog(page)
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  expect(exportRequests).toEqual([])
  await expect(exportNotice(page)).toHaveCount(0)
  await expect(exportButton(page)).toBeEnabled()
  await page.screenshot({ path: join(evidenceDir, 'destination-cancel-modal.png') })

  await writeEvidence('destination-cancel-modal', {
    viewport: page.viewportSize(),
    boundary: '取消只关闭弹窗；未发送 exportSavedScene，未得到产物。',
    exportRequests: exportRequests.length,
    notice: 0,
    exportButtonEnabled: true
  })
})

test('选择其他位置后取消系统选择器：不导出、不显示错误、确认保持禁用', async ({ page }) => {
  const chooseRequests = []
  const exportRequests = []
  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestSavedSceneVersion') {
      return fulfillJson(route, latestSaveResult())
    }
    if (payload.method === 'chooseSceneExportDirectory') {
      chooseRequests.push(payload.input)
      return fulfillJson(route, {
        code: 2000,
        msg: '导出位置选择已返回',
        data: { status: 'canceled' }
      })
    }
    if (payload.method === 'exportSavedScene') {
      exportRequests.push(payload.input)
      return fulfillJson(route, exportResult(world.exportDirectory))
    }
    return route.continue()
  })
  await openWorkbench(page)

  const dialog = await openExportDialog(page)
  await dialog.getByRole('radio', { name: /其他位置/u }).check()
  await dialog.getByRole('button', { name: '选择文件夹' }).click()
  await expect.poll(() => chooseRequests.length).toBe(1)
  await expect(dialog.getByText('尚未选择文件夹')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '开始导出' })).toBeDisabled()
  expect(exportRequests).toEqual([])
  await expect(exportNotice(page)).toHaveCount(0)
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await page.screenshot({ path: join(evidenceDir, 'destination-picker-canceled.png') })

  await writeEvidence('destination-picker-canceled', {
    viewport: page.viewportSize(),
    boundary: '系统目录选择器通过 dev 调用桩返回 canceled；只验证页面流程，不证明本机对话框行为。',
    chooseRequests,
    exportRequests: exportRequests.length,
    confirmDisabled: true,
    errorShown: false
  })
})

test('临时反馈浮层不挤压顶栏、弹窗主体和操作栏', async ({ page }) => {
  const longPath = join(
    world.exportDirectory,
    `scene-${'a'.repeat(56)}`,
    'nested-folder-name'.repeat(3)
  )
  let releaseChoose
  const chooseGate = new Promise((resolveGate) => {
    releaseChoose = resolveGate
  })

  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestSavedSceneVersion') {
      return fulfillJson(route, latestSaveResult())
    }
    if (payload.method === 'chooseSceneExportDirectory') {
      await chooseGate
      return fulfillJson(route, {
        code: 2000,
        msg: '导出位置选择已返回',
        data: { status: 'canceled' }
      })
    }
    if (payload.method === 'exportSavedScene') {
      return fulfillJson(route, exportResult(longPath))
    }
    if (payload.method === 'openDirectory') {
      return fulfillJson(route, openDirectorySuccess())
    }
    return route.continue()
  })
  await openWorkbench(page)
  await expect(exportButton(page)).toBeEnabled({ timeout: 30000 })

  const chrome = page.locator('[data-motion="chrome"]')
  const screen = page.getByTestId('workbench-screen')
  const saveButton = chrome.getByRole('button', { name: '保存', exact: true })
  const toolbarBefore = {
    chrome: await rectOf(chrome),
    export: await rectOf(exportButton(page)),
    save: await rectOf(saveButton),
    scrollTop: await screen.evaluate((element) => element.scrollTop),
    scrollLeft: await screen.evaluate((element) => element.scrollLeft)
  }

  const dialog = await openExportDialog(page)
  await dialog.getByRole('radio', { name: /其他位置/u }).check()
  const chooseButton = dialog.getByTestId('scene-export-choose')
  await expect(chooseButton).toHaveText('选择文件夹')

  const measureDialog = async () => ({
    dialog: await rectOf(dialog),
    options: await rectOf(dialog.locator('fieldset')),
    choose: await rectOf(chooseButton),
    footer: await rectOf(dialog.locator('footer')),
    cancel: await rectOf(dialog.getByRole('button', { name: '取消' })),
    confirm: await rectOf(dialog.getByRole('button', { name: '开始导出' })),
    hint: await rectOf(dialog.getByRole('status'))
  })

  const baseline = await measureDialog()
  await page.screenshot({ path: join(evidenceDir, 'feedback-layout-dialog-baseline.png') })

  await chooseButton.click()
  await expect(dialog.getByText('正在打开系统文件夹选择器…')).toBeVisible()
  const choosing = await measureDialog()
  expectSameRects(baseline, choosing, [
    'dialog',
    'options',
    'choose',
    'footer',
    'cancel',
    'confirm'
  ])
  assertHintClearsControls(choosing)
  await page.screenshot({ path: join(evidenceDir, 'feedback-layout-dialog-choosing.png') })

  releaseChoose()
  await expect(dialog.getByText('正在打开系统文件夹选择器…')).toHaveCount(0)
  await expect(dialog.getByText('尚未选择文件夹')).toBeVisible()
  const canceled = await measureDialog()
  expectSameRects(choosing, canceled, [
    'dialog',
    'options',
    'choose',
    'footer',
    'cancel',
    'confirm'
  ])
  assertHintClearsControls(canceled)
  await page.screenshot({ path: join(evidenceDir, 'feedback-layout-dialog-canceled.png') })

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()

  const exportDialog = await openExportDialog(page)
  await expect(exportDialog.getByRole('radio', { name: /工程目录（默认）/u })).toBeChecked()
  await exportDialog.getByRole('button', { name: '开始导出' }).click()
  await expect(exportDialog).toBeHidden()

  const notice = exportNotice(page)
  await expect(notice).toBeVisible({ timeout: 15000 })
  await expect(notice).toContainText(longPath)
  await expect(page.getByTestId('scene-export-notice')).toHaveCount(1)
  await expect(page.getByText('产物位置')).toHaveCount(1)
  await expect(page.getByText('已导出', { exact: true })).toHaveCount(1)

  const toolbarAfter = {
    chrome: await rectOf(chrome),
    export: await rectOf(exportButton(page)),
    save: await rectOf(saveButton),
    scrollTop: await screen.evaluate((element) => element.scrollTop),
    scrollLeft: await screen.evaluate((element) => element.scrollLeft)
  }
  expectSameRects(toolbarBefore, toolbarAfter, ['chrome', 'export', 'save'])
  expect(toolbarAfter.scrollTop).toBe(toolbarBefore.scrollTop)
  expect(toolbarAfter.scrollLeft).toBe(toolbarBefore.scrollLeft)

  const noticeRect = await rectOf(notice)
  expect(overlaps(noticeRect, toolbarAfter.chrome)).toBe(false)
  expect(overlaps(noticeRect, toolbarAfter.export)).toBe(false)
  expect(overlaps(noticeRect, toolbarAfter.save)).toBe(false)
  await page.screenshot({ path: join(evidenceDir, 'feedback-layout-success-long-path.png') })

  await writeEvidence('feedback-layout-stability', {
    viewport: page.viewportSize(),
    boundary:
      '系统目录选择器与导出结果由 dev 调用桩返回；只验证页面反馈不参与布局，不验证本机选择器或打包。',
    longPath,
    dialogBaseline: baseline,
    dialogChoosing: choosing,
    dialogCanceled: canceled,
    toolbarBefore,
    toolbarAfter,
    notice: noticeRect,
    duplicateNoticeCount: await page.getByTestId('scene-export-notice').count(),
    duplicatePathLabelCount: await page.getByText('产物位置').count()
  })
})

test('选择其他位置后导出只携带 selectionId，不把展示路径回传', async ({ page }) => {
  const chosenParent = join(world.root, 'chosen-parent')
  const exportedPath = join(chosenParent, 'scene-fixture')
  const chooseRequests = []
  const exportRequests = []
  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestSavedSceneVersion') {
      return fulfillJson(route, latestSaveResult())
    }
    if (payload.method === 'chooseSceneExportDirectory') {
      chooseRequests.push(payload.input)
      return fulfillJson(route, {
        code: 2000,
        msg: '导出位置选择已返回',
        data: {
          status: 'selected',
          selectionId,
          directoryPath: chosenParent
        }
      })
    }
    if (payload.method === 'exportSavedScene') {
      exportRequests.push(payload.input)
      return fulfillJson(route, exportResult(exportedPath))
    }
    return route.continue()
  })
  await openWorkbench(page)

  const dialog = await openExportDialog(page)
  await dialog.getByRole('radio', { name: /其他位置/u }).check()
  await dialog.getByRole('button', { name: '选择文件夹' }).click()
  await expect(dialog.getByText(chosenParent)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '开始导出' })).toBeEnabled()
  await dialog.getByRole('button', { name: '开始导出' }).click()
  await expect(dialog).toBeHidden()

  const notice = exportNotice(page)
  await expect(notice).toBeVisible({ timeout: 15000 })
  await expect(notice).toContainText(exportedPath)
  expect(chooseRequests).toEqual([{ projectId, sceneId }])
  expect(exportRequests).toHaveLength(1)
  expect(exportRequests[0].destination).toEqual({
    kind: 'selected',
    selectionId
  })
  expect(JSON.stringify(exportRequests[0])).not.toContain(chosenParent)
  await page.screenshot({ path: join(evidenceDir, 'destination-selected-export.png') })

  await writeEvidence('destination-selected-export', {
    viewport: page.viewportSize(),
    boundary:
      '目录选择与打包结果由 dev 调用桩提供；断言传输只含 selectionId，展示路径只来自选择结果。',
    chooseRequests,
    exportRequest: exportRequests[0],
    exportedPath,
    exportNoticeVisible: true
  })
})

test('已提交气泡的导出按钮打开同一个目的地弹窗', async ({ page }) => {
  const exportRequests = []
  await page.route('**/__opengalgame/dev/call', async (route) => {
    const payload = devCallOf(route.request())
    if (payload === null) return route.continue()
    if (payload.method === 'readLatestSavedSceneVersion') {
      return fulfillJson(route, latestSaveResult())
    }
    if (payload.method === 'listSceneGenerationHistory') {
      return fulfillJson(route, {
        code: 2000,
        msg: '生成历史已返回',
        data: [historySummary]
      })
    }
    if (payload.method === 'getSceneGenerationStatus') {
      return fulfillJson(route, {
        code: 2000,
        msg: '生成状态已返回',
        data: completedStatus
      })
    }
    if (payload.method === 'subscribeSceneGenerationProgress') {
      return fulfillJson(route, { code: 2000, msg: '已订阅', data: null })
    }
    if (payload.method === 'exportSavedScene') {
      exportRequests.push(payload.input)
      return fulfillJson(route, exportResult(world.exportDirectory))
    }
    return route.continue()
  })
  await openWorkbench(page)
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '创作抽屉' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('已提交', { exact: true }).first()).toBeVisible({
    timeout: 20000
  })

  const exportBubble = drawer.getByRole('button', { name: '导出当前场景' })
  await expect(exportBubble).toBeEnabled({ timeout: 15000 })
  await exportBubble.click()
  const dialog = page.getByRole('dialog', { name: '导出当前场景' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /工程目录（默认）/u })).toBeChecked()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  expect(exportRequests).toEqual([])
  await page.screenshot({ path: join(evidenceDir, 'destination-bubble-entry.png') })

  await writeEvidence('destination-bubble-entry', {
    viewport: page.viewportSize(),
    boundary:
      '生成状态与历史由 dev 调用桩提供；只验证已提交气泡按钮打开同一弹窗，不证明真实生成完成。',
    dialogOpened: true,
    exportRequests: exportRequests.length
  })
})
