const { test, expect } = require('@playwright/test')
const { execFileSync, spawn } = require('node:child_process')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const net = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { seedGuidePreference } = require('./support/guide-preference.cjs')

const appRoot = resolve(__dirname, '..', '..')
const evidenceDir = join(appRoot, 'artifacts', 'preview-r03')
const originalScene = '小明:第一句;\n旁白:第二句;\n小明:第三句;\n'
const sceneId = 'scene-1'
const projectId = 'p-01'

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
test.setTimeout(90000)

let world
let server
let baseUrl

function git(args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', ...args],
    { cwd: world.projectRoot, encoding: 'utf8' }
  )
}

async function seedWorld() {
  const root = await mkdtemp(join(tmpdir(), 'preview-r03-'))
  const userDirectory = join(root, 'userhome')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory, { recursive: true })
  const canvasDirectory = join(
    projectRoot,
    '.opengalgame',
    'canvases',
    Buffer.from(sceneId, 'utf8').toString('hex')
  )
  await mkdir(join(projectRoot, 'game', 'scene'), { recursive: true })
  await mkdir(canvasDirectory, { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame', 'project.json'),
    JSON.stringify({ id: projectId, name: '预览工程', synopsis: '' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId, operationId: 'op-register' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'scene-locks.json'),
    JSON.stringify({ scenes: [{ sceneId, lockState: 'unlocked' }] })
  )
  await writeFile(join(canvasDirectory, 'canvas.json'), '{}')
  await writeFile(join(projectRoot, 'game', 'scene', 'start.txt'), originalScene)
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
  return { root, userDirectory, projectRoot }
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
      String(port),
      '--open',
      'false'
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
  server = child
}

const children = new Set()

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

async function resetScene() {
  await writeFile(join(world.projectRoot, 'game', 'scene', 'start.txt'), originalScene)
  git(['add', 'game/scene/start.txt'])
  git(['commit', '--allow-empty', '-m', 'reset scene'])
}

async function openWorkbench(page) {
  await seedGuidePreference(page)
  await page.goto(baseUrl)
  await expect(page.getByRole('button', { name: /导入项目/ })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '项目选择' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 20000 })
  const previewAction = page.locator('[data-action="preview"]')
  await expect(previewAction).toBeEnabled({ timeout: 30000 })
}

function isDevCall(request, method) {
  try {
    return request.postDataJSON()?.method === method
  } catch {
    return false
  }
}

async function openPreview(page) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/__opengalgame/dev/call') &&
      isDevCall(response.request(), 'openScenePreview')
  )
  await page.locator('[data-action="preview"]').click()
  const layer = page.getByTestId('preview-page')
  await expect(layer).toBeVisible({ timeout: 20000 })
  const response = await responsePromise
  const payload = await response.json()
  expect(payload.code).toBe(2000)
  const previewSessionId = payload.data.previewSessionId
  await expect(layer.locator('[data-dialogue-id]')).toHaveCount(3, { timeout: 30000 })
  await expect(layer.getByText('已定位').first()).toBeVisible({ timeout: 30000 })
  return { layer, previewSessionId }
}

async function closeByBack(page, layer, actionName) {
  await layer.getByRole('button', { name: '返回工作台' }).click()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: actionName }).click()
  await expect(layer).toBeHidden({ timeout: 15000 })
}

async function editDialogue(page, layer, index, text) {
  const row = layer.locator('[data-dialogue-id]').nth(index)
  await row.locator('button').first().click()
  const editor = layer.getByRole('textbox', { name: `编辑第 ${index + 1} 句` })
  await expect(editor).toBeVisible()
  await editor.fill(text)
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  return row
}

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true })
  await startServer()
})

test.afterAll(async () => {
  await stopChildren()
  if (world) await rm(world.root, { recursive: true, force: true })
})

test.beforeEach(async () => {
  await resetScene()
})

test('打开预览显示真实会话，关闭后重开得到新的预览会话', async ({ page }) => {
  await openWorkbench(page)
  const first = await openPreview(page)
  await expect(first.layer.getByRole('heading', { name: '预览工程' })).toBeVisible()
  await expect(first.layer).toContainText('试玩预览 · 当前场景')
  await page.screenshot({ path: join(evidenceDir, 'preview-open.png'), fullPage: false })

  await closeByBack(page, first.layer, '返回工作台')
  const second = await openPreview(page)
  expect(second.previewSessionId).not.toBe(first.previewSessionId)
  await expect(second.layer.locator('[data-dialogue-id]')).toHaveCount(3)
  await closeByBack(page, second.layer, '返回工作台')
})

test('关闭后迟到的打开响应会被关闭，不把关闭的会话留在后台', async ({ page }) => {
  let delayed = false
  await page.route('**/__opengalgame/dev/call', async (route) => {
    if (!delayed && isDevCall(route.request(), 'openScenePreview')) {
      delayed = true
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500))
    }
    await route.continue()
  })

  await openWorkbench(page)
  const openResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/__opengalgame/dev/call') &&
      isDevCall(response.request(), 'openScenePreview')
  )
  const closeRequest = page.waitForRequest(
    (request) =>
      request.url().includes('/__opengalgame/dev/call') && isDevCall(request, 'closeScenePreview')
  )
  await page.locator('[data-action="preview"]').click()
  const layer = page.getByTestId('preview-page')
  await expect(layer).toBeVisible()
  await layer.getByRole('button', { name: '返回工作台' }).click()
  await expect(layer).toBeHidden({ timeout: 15000 })

  const response = await openResponse
  const lateSessionId = (await response.json()).data.previewSessionId
  const closeCall = await closeRequest
  expect(closeCall.postDataJSON().input.previewSessionId).toBe(lateSessionId)
  await page.unroute('**/__opengalgame/dev/call')

  const reopened = await openPreview(page)
  expect(reopened.previewSessionId).not.toBe(lateSessionId)
  await page.screenshot({ path: join(evidenceDir, 'preview-late-request-reopen.png') })
  await closeByBack(page, reopened.layer, '返回工作台')
})

test('选中句进入草稿，撤销与重做作用在同一句且仍保持选中', async ({ page }) => {
  await openWorkbench(page)
  const { layer } = await openPreview(page)
  const rows = layer.locator('[data-dialogue-id]')

  const row = await editDialogue(page, layer, 1, '第二句改')
  await expect(rows.nth(1)).toContainText('第二句改')
  await expect(row.getByLabel('已修改')).toBeVisible()
  await expect(rows.nth(1).locator('button').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(layer.getByText('第 2 句 / 共 3 句').first()).toBeVisible({ timeout: 20000 })

  const undo = layer.getByRole('button', { name: '撤销' })
  const redo = layer.getByRole('button', { name: '重做' })
  await expect(undo).toBeEnabled()
  await expect(redo).toBeDisabled()

  await undo.click()
  await expect(rows.nth(1)).toContainText('第二句')
  await expect(rows.nth(1)).not.toContainText('第二句改')
  await expect(row.getByLabel('已修改')).toHaveCount(0)
  await expect(redo).toBeEnabled()

  await redo.click()
  await expect(rows.nth(1)).toContainText('第二句改')
  await expect(row.getByLabel('已修改')).toBeVisible()
  await page.screenshot({ path: join(evidenceDir, 'preview-draft-redo.png') })
  await expect(rows.nth(1).locator('button').first()).toHaveAttribute('aria-pressed', 'true')

  await undo.click()
  await expect(rows.nth(1)).not.toContainText('第二句改')
  await closeByBack(page, layer, '返回工作台')
})

test('保存通信失败时进入待确认，查看结算后保留草稿并明确未找到记录', async ({ page }) => {
  await openWorkbench(page)
  const { layer } = await openPreview(page)
  let aborted = false
  await page.route('**/__opengalgame/dev/call', async (route) => {
    if (!aborted && isDevCall(route.request(), 'saveDialogueChanges')) {
      aborted = true
      await route.abort('failed')
      return
    }
    await route.continue()
  })

  await editDialogue(page, layer, 0, '待确认草稿')
  await layer.getByRole('button', { name: '保存', exact: true }).click()
  await expect(layer.getByText('保存结果待确认').first()).toBeVisible({ timeout: 20000 })
  await expect(layer.getByRole('button', { name: '查看结果' })).toBeVisible()
  await page.screenshot({ path: join(evidenceDir, 'preview-pending.png') })

  await layer.getByRole('button', { name: '查看结果' }).click()
  await expect(layer.getByText('没有找到这次保存记录，内容仍保留在左侧。').first()).toBeVisible({
    timeout: 20000
  })
  await expect(layer.locator('[data-dialogue-id]').first()).toContainText('待确认草稿')
  expect(await readFile(join(world.projectRoot, 'game', 'scene', 'start.txt'), 'utf8')).toBe(
    originalScene
  )

  await closeByBack(page, layer, '放弃并离开')
})

test('保存成功后写入真实工程文件，重开预览读取已保存正文', async ({ page }) => {
  await openWorkbench(page)
  const { layer } = await openPreview(page)
  await editDialogue(page, layer, 0, '第一句已保存')

  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/__opengalgame/dev/call') &&
      isDevCall(response.request(), 'saveDialogueChanges')
  )
  await layer.getByRole('button', { name: '保存', exact: true }).click()
  const saved = await (await saveResponse).json()
  expect(saved.data.status).toBe('saved')
  await expect
    .poll(() => readFile(join(world.projectRoot, 'game', 'scene', 'start.txt'), 'utf8'))
    .toContain('第一句已保存')
  await page.screenshot({ path: join(evidenceDir, 'preview-saved.png') })

  await closeByBack(page, layer, '返回工作台')
  const reopened = await openPreview(page)
  await expect(reopened.layer.locator('[data-dialogue-id]').first()).toContainText('第一句已保存')
  await page.screenshot({ path: join(evidenceDir, 'preview-reopen-saved.png') })
  await closeByBack(page, reopened.layer, '返回工作台')
})
