const { test, expect } = require('@playwright/test')
const { execFileSync, spawn } = require('node:child_process')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const net = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { mediaFixtures } = require('./support/media-fixtures.cjs')

const appRoot = resolve(__dirname, '..', '..')
const evidenceDir = join(appRoot, 'artifacts', 'media-r24')
const projectId = 'p-01'
const sceneId = 'scene-1'
const canvasId = 'canvas-1'

/**
 * 浏览器的 Blob URL 创建与撤销是产品可观察结果。这里只记录真实调用，不改写实现；
 * 断言「目录缩略图和画布卡片共享一个 URL」以及「最后一个消费者离开后才撤销」。
 */
async function recordBlobUrls(page) {
  await page.addInitScript(() => {
    const created = []
    const revoked = []
    const createObjectUrl = URL.createObjectURL.bind(URL)
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (blob) => {
      const url = createObjectUrl(blob)
      created.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      revoked.push(url)
      revokeObjectUrl(url)
    }
    Object.defineProperty(window, '__mediaBlobUrls', { value: { created, revoked } })
  })
}

/**
 * 记录真实媒体读取请求，用来确认共享在途读取没有重复请求。
 * 浏览器真实文件模式走 /__opengalgame/dev/media；保留 dev/call 统计以兼容其他装配。
 */
function recordMediaReads(page) {
  const reads = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/__opengalgame/dev/media') {
      const sourceId = url.searchParams.get('sourceId')
      if (sourceId) reads.push(sourceId)
      return
    }
    if (url.pathname !== '/__opengalgame/dev/call') return
    try {
      const payload = request.postDataJSON()
      if (payload?.method === 'readProjectMedia') reads.push(payload.input?.sourceId)
    } catch {
      // 非 JSON 请求不参与统计。
    }
  })
  return reads
}

/** 读取页面里真实发生的 Blob URL 创建和撤销记录，作为可观察证据落盘。 */
async function blobState(page) {
  return page.evaluate(() => ({
    created: [...window.__mediaBlobUrls.created],
    revoked: [...window.__mediaBlobUrls.revoked]
  }))
}

async function writeEvidence(name, payload) {
  await writeFile(join(evidenceDir, name), `${JSON.stringify(payload, null, 2)}\n`)
}

/** 读取工作台外壳的滚动量与固定区域位置，用于断言操作和焦点不移动外壳。 */
async function shellGeometry(page) {
  return page.evaluate(() => {
    const box = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const scroll = (element) =>
      element ? { top: element.scrollTop, left: element.scrollLeft } : null
    const screen = document.querySelector('[data-testid="workbench-screen"]')
    const stage = document.querySelector('section[aria-label="场景画布"]')
    const canvasArea = stage ? stage.parentElement : null
    const viewport = document.querySelector('[data-testid="scene-canvas"]')
    return {
      screen: scroll(screen),
      canvasArea: scroll(canvasArea),
      stage: scroll(stage),
      viewport: scroll(viewport),
      topbar: box(screen ? screen.querySelector(':scope > header') : null),
      catalog: box(document.querySelector('[data-testid="input-catalog"]'))
    }
  })
}

async function expectShellUnscrolled(page, before) {
  const after = await shellGeometry(page)
  expect(after.screen).toEqual({ top: 0, left: 0 })
  expect(after.canvasArea).toEqual({ top: 0, left: 0 })
  expect(after.stage).toEqual({ top: 0, left: 0 })
  expect(after.viewport).toEqual({ top: 0, left: 0 })
  for (const key of ['topbar', 'catalog']) {
    expect(after[key]).not.toBeNull()
    expect(Math.abs(after[key].x - before[key].x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after[key].y - before[key].y)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after[key].width - before[key].width)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after[key].height - before[key].height)).toBeLessThanOrEqual(0.5)
  }
}

/** 等待页面过渡与工作台入场清理 transform，避免把入场位移误判成外壳漂移。 */
async function waitForShellSettled(page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const screen = document.querySelector('[data-testid="workbench-screen"]')
        if (!screen) return 'missing'
        const targets = [
          screen.parentElement,
          ...screen.querySelectorAll(
            '[data-motion="chrome"], [data-motion="panel"], [data-motion="stage"], [data-motion="save"]'
          )
        ]
        const moving = targets.filter(
          (target) =>
            target instanceof HTMLElement &&
            !/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(target).transform)
        )
        return moving.length === 0 ? 'settled' : `${moving.length} moving`
      })
    )
    .toBe('settled')
}

/** 断言最上层弹窗内容中心与视口中心的偏差不超过 2px。 */
async function expectDialogCentered(page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const dialog = [...document.querySelectorAll('dialog[open]')].at(-1)
          if (!(dialog instanceof HTMLDialogElement)) return Infinity
          const rect = dialog.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          return Math.max(Math.abs(centerX - innerWidth / 2), Math.abs(centerY - innerHeight / 2))
        }),
      { timeout: 3000 }
    )
    .toBeLessThanOrEqual(2)
}

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

function hex(value) {
  return Buffer.from(value, 'utf8').toString('hex')
}

function mediaDescriptor(source) {
  return {
    formatVersion: 1,
    projectId,
    sourceId: source.sourceId,
    content: {
      kind: 'asset',
      name: source.fileName,
      fileType: source.kind,
      description: '',
      fileId: source.sourceId,
      mediaPath: `assets/${hex(source.sourceId)}/${source.fileName}`
    }
  }
}

function arrangementDocument() {
  return {
    formatVersion: 4,
    projectId,
    sceneId,
    canvasId,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'image',
        cardId: 'card-image',
        sourceId: mediaFixtures.image.sourceId,
        role: 'background',
        title: '雨夜屋顶',
        summary: '',
        layout: { x: 40, y: 40, width: 320, height: 220 }
      },
      {
        kind: 'audio',
        cardId: 'card-audio',
        sourceId: mediaFixtures.audio.sourceId,
        role: 'music',
        title: '雨声',
        summary: '',
        layout: { x: 400, y: 40, width: 320, height: 180 }
      },
      {
        kind: 'video',
        cardId: 'card-video',
        sourceId: mediaFixtures.video.sourceId,
        title: '雨夜转场',
        summary: '',
        layout: { x: 40, y: 300, width: 320, height: 220 }
      }
    ],
    relations: []
  }
}

async function seedWorld() {
  const root = await mkdtemp(join(tmpdir(), 'media-r24-'))
  const userDirectory = join(root, 'userhome')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory, { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame', 'inputs', 'sources'), { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame', 'canvases', hex(sceneId)), { recursive: true })
  await mkdir(join(projectRoot, 'game', 'scene'), { recursive: true })

  await writeFile(
    join(projectRoot, '.opengalgame', 'project.json'),
    JSON.stringify({ id: projectId, name: '媒体预览工程', synopsis: '' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId, operationId: 'op-register' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'scene-locks.json'),
    JSON.stringify({ scenes: [{ sceneId, lockState: 'unlocked' }] })
  )
  await writeFile(
    join(projectRoot, '.opengalgame', 'inputs', 'catalog.json'),
    JSON.stringify({ formatVersion: 1, projectId, folders: [], placements: [] })
  )
  await writeFile(join(projectRoot, 'game', 'scene', 'start.txt'), '旁白:媒体预览;\n')

  for (const source of Object.values(mediaFixtures)) {
    const descriptorPath = join(
      projectRoot,
      '.opengalgame',
      'inputs',
      'sources',
      `${hex(source.sourceId)}.json`
    )
    const assetDirectory = join(projectRoot, 'assets', hex(source.sourceId))
    await mkdir(assetDirectory, { recursive: true })
    await writeFile(descriptorPath, JSON.stringify(mediaDescriptor(source)))
    await writeFile(join(assetDirectory, source.fileName), source.bytes)
  }

  await writeArrangement(projectRoot)
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

async function writeArrangement(projectRoot) {
  await writeFile(
    join(projectRoot, '.opengalgame', 'canvases', hex(sceneId), `${hex(canvasId)}.json`),
    JSON.stringify(arrangementDocument())
  )
}

function git(args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', ...args],
    { cwd: world.projectRoot, encoding: 'utf8' }
  )
}

async function resetArrangement() {
  await writeArrangement(world.projectRoot)
  git(['add', '.opengalgame/canvases'])
  git(['commit', '--allow-empty', '-m', 'reset arrangement'])
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
  await expect(page.getByTestId('input-catalog')).toBeVisible({ timeout: 30000 })
}

function sourceRow(page, fileName) {
  return page.getByTestId('input-source-row').filter({ hasText: fileName })
}

async function visitProjects(page) {
  await page.getByRole('button', { name: '返回项目页' }).click()
  await expect(page.getByRole('heading', { name: '项目' })).toBeVisible({ timeout: 15000 })
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
  await resetArrangement()
})

test('真实工程字节显示图像、音频和视频，并由目录缩略图与画布卡片共享同一份 Blob URL', async ({
  page
}) => {
  await recordBlobUrls(page)
  const reads = recordMediaReads(page)
  await openWorkbench(page)

  const imageRow = sourceRow(page, mediaFixtures.image.fileName)
  await expect(imageRow).toBeVisible({ timeout: 30000 })
  const rowImage = imageRow.locator('img')
  await expect(rowImage).toBeVisible({ timeout: 30000 })
  await expect.poll(() => rowImage.evaluate((image) => image.naturalWidth)).toBe(64)
  await expect.poll(() => rowImage.evaluate((image) => image.naturalHeight)).toBe(36)
  const imageUrl = await rowImage.getAttribute('src')
  expect(imageUrl).toMatch(/^blob:/)

  const imageCard = page.getByTestId('rf__node-card-image')
  await expect(imageCard).toBeVisible({ timeout: 30000 })
  const cardImage = imageCard.locator('img')
  await expect(cardImage).toBeVisible()
  await expect.poll(() => cardImage.evaluate((image) => image.naturalWidth)).toBe(64)
  expect(await cardImage.getAttribute('src')).toBe(imageUrl)

  const audioRow = sourceRow(page, mediaFixtures.audio.fileName)
  await expect(audioRow).toBeVisible()
  const rowAudio = audioRow.locator('audio')
  await expect(rowAudio).toHaveCount(1)
  await expect.poll(() => rowAudio.evaluate((audio) => audio.readyState)).toBeGreaterThanOrEqual(1)
  await expect.poll(() => rowAudio.evaluate((audio) => audio.duration)).toBeGreaterThan(2)
  const audioUrl = await rowAudio.getAttribute('src')
  expect(audioUrl).toMatch(/^blob:/)

  const audioCard = page.getByTestId('rf__node-card-audio')
  await expect(audioCard).toBeVisible()
  const cardAudio = audioCard.locator('audio')
  await expect(cardAudio).toHaveCount(1)
  await expect.poll(() => cardAudio.evaluate((audio) => audio.readyState)).toBeGreaterThanOrEqual(1)
  expect(await cardAudio.getAttribute('src')).toBe(audioUrl)
  await audioCard.hover()
  await audioCard.getByRole('button', { name: '播放 雨声' }).click()
  await expect(audioCard.locator('[data-audio-state="playing"]')).toBeVisible()
  await expect.poll(() => cardAudio.evaluate((audio) => audio.paused)).toBe(false)
  const audioPlayingState = await audioCard
    .locator('[data-audio-state]')
    .getAttribute('data-audio-state')
  const audioPlayingPaused = await cardAudio.evaluate((audio) => audio.paused)
  await audioCard.getByRole('button', { name: '暂停 雨声' }).click()
  await expect(audioCard.locator('[data-audio-state="ready"]')).toBeVisible()

  const videoRow = sourceRow(page, mediaFixtures.video.fileName)
  await expect(videoRow).toBeVisible()
  const rowVideo = videoRow.locator('video')
  await expect(rowVideo).toHaveCount(1)
  await expect.poll(() => rowVideo.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1)
  await expect.poll(() => rowVideo.evaluate((video) => video.videoWidth)).toBe(64)
  const videoUrl = await rowVideo.getAttribute('src')
  expect(videoUrl).toMatch(/^blob:/)

  const videoCard = page.getByTestId('rf__node-card-video')
  await expect(videoCard).toBeVisible()
  const cardVideo = videoCard.locator('video')
  await expect(cardVideo).toHaveCount(1)
  await expect.poll(() => cardVideo.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1)
  await expect.poll(() => cardVideo.evaluate((video) => video.videoWidth)).toBe(64)
  expect(await cardVideo.getAttribute('src')).toBe(videoUrl)
  await videoCard.hover()
  await videoCard.getByRole('button', { name: '播放 雨夜转场' }).click()
  await expect(videoCard.locator('[data-playing="true"]')).toBeVisible()
  await expect.poll(() => cardVideo.evaluate((video) => video.paused)).toBe(false)
  const videoPlayingMark = await videoCard.locator('[data-playing]').getAttribute('data-playing')
  const videoPlayingPaused = await cardVideo.evaluate((video) => video.paused)
  await videoCard.getByRole('button', { name: '暂停 雨夜转场' }).click()

  await expect.poll(() => reads.filter((id) => id === mediaFixtures.image.sourceId).length).toBe(1)
  await expect.poll(() => reads.filter((id) => id === mediaFixtures.audio.sourceId).length).toBe(1)
  await expect.poll(() => reads.filter((id) => id === mediaFixtures.video.sourceId).length).toBe(1)
  const created = await page.evaluate(() => [...window.__mediaBlobUrls.created])
  const mediaUrls = [imageUrl, audioUrl, videoUrl]
  expect(new Set(mediaUrls).size).toBe(3)
  for (const url of mediaUrls) expect(created).toContain(url)
  await page.screenshot({ path: join(evidenceDir, 'media-loaded.png') })
  const loadedEvidence = {
    viewport: page.viewportSize(),
    urls: { image: imageUrl, audio: audioUrl, video: videoUrl },
    reads: {
      image: reads.filter((id) => id === mediaFixtures.image.sourceId).length,
      audio: reads.filter((id) => id === mediaFixtures.audio.sourceId).length,
      video: reads.filter((id) => id === mediaFixtures.video.sourceId).length
    },
    blobUrls: await blobState(page),
    image: {
      thumbnailNaturalWidth: await rowImage.evaluate((image) => image.naturalWidth),
      thumbnailNaturalHeight: await rowImage.evaluate((image) => image.naturalHeight),
      cardNaturalWidth: await cardImage.evaluate((image) => image.naturalWidth),
      cardNaturalHeight: await cardImage.evaluate((image) => image.naturalHeight),
      sharedUrl: (await cardImage.getAttribute('src')) === (await rowImage.getAttribute('src'))
    },
    audio: {
      readyState: await cardAudio.evaluate((audio) => audio.readyState),
      duration: await cardAudio.evaluate((audio) => audio.duration),
      sharedUrl: (await cardAudio.getAttribute('src')) === (await rowAudio.getAttribute('src')),
      playingState: audioPlayingState,
      pausedWhilePlaying: audioPlayingPaused,
      pausedAfterPause: await cardAudio.evaluate((audio) => audio.paused),
      deckState: await audioCard.locator('[data-audio-state]').getAttribute('data-audio-state')
    },
    video: {
      readyState: await cardVideo.evaluate((video) => video.readyState),
      videoWidth: await cardVideo.evaluate((video) => video.videoWidth),
      sharedUrl: (await cardVideo.getAttribute('src')) === (await rowVideo.getAttribute('src')),
      playingMark: videoPlayingMark,
      pausedWhilePlaying: videoPlayingPaused,
      pausedAfterPause: await cardVideo.evaluate((video) => video.paused)
    }
  }

  await visitProjects(page)
  await expect
    .poll(async () => {
      const revoked = await page.evaluate(() => [...window.__mediaBlobUrls.revoked])
      return mediaUrls.map((url) => revoked.filter((item) => item === url).length)
    })
    .toEqual([1, 1, 1])
  expect(
    await page.evaluate(() => {
      return document.querySelectorAll('img[src^="blob:"],audio[src^="blob:"],video[src^="blob:"]')
        .length
    })
  ).toBe(0)
  await page.screenshot({ path: join(evidenceDir, 'media-after-close.png') })
  const closedEvidence = {
    blobUrls: await blobState(page),
    revokedCounts: await page.evaluate((urls) => {
      return urls.map((url) => window.__mediaBlobUrls.revoked.filter((item) => item === url).length)
    }, mediaUrls),
    residualBlobElements: await page.evaluate(() => {
      return document.querySelectorAll('img[src^="blob:"],audio[src^="blob:"],video[src^="blob:"]')
        .length
    })
  }

  await page.getByTestId('project-card').first().click()
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 30000 })
  await expect(sourceRow(page, mediaFixtures.image.fileName).locator('img')).toBeVisible()
  await expect.poll(() => reads.filter((id) => id === mediaFixtures.image.sourceId).length).toBe(2)
  await writeEvidence('media-loaded-evidence.json', {
    ...loadedEvidence,
    closed: closedEvidence,
    readsAfterReopen: {
      image: reads.filter((id) => id === mediaFixtures.image.sourceId).length,
      audio: reads.filter((id) => id === mediaFixtures.audio.sourceId).length,
      video: reads.filter((id) => id === mediaFixtures.video.sourceId).length
    }
  })
})

test('真实读取完成前显示加载占位，完成后同一位置显示媒体', async ({ page }) => {
  await recordBlobUrls(page)
  let releaseImageRead
  const imageReadGate = new Promise((resolveGate) => {
    releaseImageRead = resolveGate
  })
  await page.route(/\/__opengalgame\/dev\/media(?:\?|$)/, async (route) => {
    const sourceId = new URL(route.request().url()).searchParams.get('sourceId')
    if (sourceId === mediaFixtures.image.sourceId) await imageReadGate
    await route.continue()
  })

  await openWorkbench(page)
  const imageCard = page.getByTestId('rf__node-card-image')
  await expect(imageCard).toBeVisible({ timeout: 30000 })
  await expect(imageCard.getByLabel('正在读取媒体')).toBeVisible()
  await expect(imageCard.locator('img')).toHaveCount(0)
  await page.screenshot({ path: join(evidenceDir, 'media-loading.png') })
  const loadingEvidence = {
    placeholderVisible: await imageCard.getByLabel('正在读取媒体').isVisible(),
    imageCount: await imageCard.locator('img').count(),
    blobUrls: await blobState(page)
  }
  releaseImageRead()
  await expect(imageCard.locator('img')).toBeVisible({ timeout: 30000 })
  await expect.poll(() => imageCard.locator('img').evaluate((image) => image.naturalWidth)).toBe(64)
  await page.screenshot({ path: join(evidenceDir, 'media-loading-settled.png') })
  await writeEvidence('media-loading-evidence.json', {
    viewport: page.viewportSize(),
    loading: loadingEvidence,
    settled: {
      imageCount: await imageCard.locator('img').count(),
      naturalWidth: await imageCard.locator('img').evaluate((image) => image.naturalWidth),
      naturalHeight: await imageCard.locator('img').evaluate((image) => image.naturalHeight),
      src: await imageCard.locator('img').getAttribute('src'),
      blobUrls: await blobState(page)
    }
  })
  await page.unroute(/\/__opengalgame\/dev\/media(?:\?|$)/)
})

test('删除一个消费方不提前撤销仍被目录缩略图使用的 Blob URL，最后返回项目页才释放', async ({
  page
}) => {
  await recordBlobUrls(page)
  const reads = recordMediaReads(page)
  await openWorkbench(page)

  const imageRow = sourceRow(page, mediaFixtures.image.fileName)
  const rowImage = imageRow.locator('img')
  await expect(rowImage).toBeVisible({ timeout: 30000 })
  const imageUrl = await rowImage.getAttribute('src')
  expect(imageUrl).toMatch(/^blob:/)
  await expect.poll(() => rowImage.evaluate((image) => image.naturalWidth)).toBe(64)
  const beforeDeleteEvidence = {
    imageUrl,
    revoked: (await blobState(page)).revoked,
    rowNaturalWidth: await rowImage.evaluate((image) => image.naturalWidth),
    reads: reads.filter((id) => id === mediaFixtures.image.sourceId).length
  }

  // 负向控制：让 release 在 refs 仍大于 0 时撤销，删除画布卡片后目录缩略图会收到已撤销 URL，
  // 下面的“不包含 imageUrl”与 naturalWidth 断言会失败。
  const imageCard = page.getByTestId('rf__node-card-image')
  await expect(imageCard).toBeVisible()
  await expect(imageCard.locator('img')).toHaveAttribute('src', imageUrl)
  await imageCard.click({ button: 'right' })
  const menu = page.getByTestId('canvas-card-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '删除卡片' }).click()
  await expect(imageCard).toHaveCount(0)

  // 缓存用 0ms 定时器延迟撤销。清空同一任务队列后再断言，避免把“还没执行”当成“没有撤销”。
  await page.evaluate(() => new Promise((resolveTick) => setTimeout(resolveTick, 0)))
  expect(await page.evaluate(() => [...window.__mediaBlobUrls.revoked])).not.toContain(imageUrl)
  await expect(rowImage).toBeVisible()
  await expect.poll(() => rowImage.evaluate((image) => image.naturalWidth)).toBe(64)
  await expect.poll(() => reads.filter((id) => id === mediaFixtures.image.sourceId).length).toBe(1)
  await page.screenshot({ path: join(evidenceDir, 'media-after-card-delete.png') })
  const afterDeleteEvidence = {
    revoked: (await blobState(page)).revoked,
    rowVisible: await rowImage.isVisible(),
    rowNaturalWidth: await rowImage.evaluate((image) => image.naturalWidth),
    reads: reads.filter((id) => id === mediaFixtures.image.sourceId).length
  }

  await visitProjects(page)
  await expect
    .poll(async () =>
      page.evaluate(
        (url) => window.__mediaBlobUrls.revoked.filter((item) => item === url).length,
        imageUrl
      )
    )
    .toBe(1)
  await page.screenshot({ path: join(evidenceDir, 'media-after-last-release.png') })
  await writeEvidence('media-release-evidence.json', {
    viewport: page.viewportSize(),
    beforeDelete: beforeDeleteEvidence,
    afterDelete: afterDeleteEvidence,
    afterClose: {
      revokedCount: await page.evaluate(
        (url) => window.__mediaBlobUrls.revoked.filter((item) => item === url).length,
        imageUrl
      ),
      blobUrls: await blobState(page),
      residualBlobElements: await page.evaluate(() => {
        return document.querySelectorAll(
          'img[src^="blob:"],audio[src^="blob:"],video[src^="blob:"]'
        ).length
      })
    }
  })
})

test('工作台外壳不因新增、保存和编辑弹窗滚动', async ({ page }) => {
  await openWorkbench(page)
  await expect(page.getByTestId('rf__node-card-image')).toBeVisible()
  await waitForShellSettled(page)
  const before = await shellGeometry(page)

  await page.getByRole('button', { name: '添加提示词卡' }).click()
  await expect(page.getByText('已添加提示词卡')).toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const saveState = page.locator('[data-motion="save"] [data-tone]')
  await expect(saveState).toHaveAttribute('data-tone', 'ok')
  await expect(saveState).toContainText('已保存')

  await page.getByTestId('rf__node-card-image').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑标题和用途说明' }).click()
  await expect(page.getByRole('heading', { name: '编辑输入卡片' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('edit-card-title')
  await expectDialogCentered(page)
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)

  await expectShellUnscrolled(page, before)
})
