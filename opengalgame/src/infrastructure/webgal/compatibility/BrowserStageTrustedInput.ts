import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  CandidateScreenButton,
  CandidateScreenFacts,
  CandidateTrustedInput,
  CandidateTrustedInputSource
} from './candidateGameStart'

type StageAction = {
  readonly kind: 'read' | 'activate' | 'wait-language'
  readonly text?: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type StageSession = {
  readonly origin: string
  readonly actions: StageAction[]
  readonly signal: AbortSignal
  pageOpen: boolean
  active: StageAction | undefined
}

const sessions = new Map<string, StageSession>()

/**
 * 浏览器开发环境没有 Electron 窗口，不能发送系统鼠标事件。
 * 同源舞台页只点击引擎里真实可见的按钮；页面不在或按钮不存在时明确失败。
 */
export function createBrowserStageTrustedInput(): CandidateTrustedInputSource {
  return ({ stageUrl, signal }) => {
    let origin: string
    try {
      const url = new URL(stageUrl)
      if (
        url.protocol !== 'http:' ||
        (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
      ) {
        return null
      }
      origin = url.origin
    } catch {
      return null
    }
    const id = `stage-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const session: StageSession = {
      origin,
      actions: [],
      signal,
      pageOpen: false,
      active: undefined
    }
    sessions.set(id, session)
    const release = (): void => {
      sessions.delete(id)
      failPending(session, abortError(signal))
    }
    if (signal.aborted) {
      release()
      return null
    }
    signal.addEventListener('abort', release, { once: true })
    return new BrowserStageTrustedInput(
      id,
      origin,
      `${origin}/__opengalgame/stage-input/${encodeURIComponent(id)}`
    )
  }
}

export function browserStageInputUrl(baseUrl: string, pageId: string): string {
  return `${baseUrl}/__opengalgame/stage-input/${encodeURIComponent(pageId)}`
}

export function serveBrowserStageInput(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const prefix = '/__opengalgame/stage-input/'
  if (!url.pathname.startsWith(prefix)) return false
  const id = decodeURIComponent(url.pathname.slice(prefix.length))
  const session = sessions.get(id)
  if (!session) {
    writeText(response, 404, '舞台输入已结束')
    return true
  }
  if (request.method === 'GET' && url.searchParams.get('next') === '1') {
    void answerNextAction(request, response, session)
    return true
  }
  if (request.method === 'POST' && url.searchParams.get('result') === '1') {
    void acceptActionResult(request, response, session)
    return true
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeText(response, 405, '舞台输入方法无效')
    return true
  }
  session.pageOpen = true
  const html = Buffer.from(stageInputPage(session.origin), 'utf8')
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(html.byteLength),
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src http://127.0.0.1:* http://localhost:*; media-src http://127.0.0.1:* http://localhost:*; font-src http://127.0.0.1:* http://localhost:*; frame-src http://127.0.0.1:* http://localhost:*; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*"
  })
  if (request.method === 'HEAD') response.end()
  else response.end(html)
  return true
}

class BrowserStageTrustedInput implements CandidateTrustedInput {
  constructor(
    private readonly pageId: string,
    private readonly origin: string,
    readonly stagePageUrl: string
  ) {}

  readScreen(signal: AbortSignal): Promise<CandidateScreenFacts | null> {
    const session = sessions.get(this.pageId)
    if (!session?.pageOpen) return Promise.resolve(null)
    return this.request('read', undefined, signal) as Promise<CandidateScreenFacts | null>
  }

  async click(): Promise<void> {
    throw new Error('浏览器不能按坐标伪造点击')
  }

  async activate(button: CandidateScreenButton): Promise<void> {
    const clicked = await this.request('activate', button.text, this.sessionSignal())
    if (clicked !== true) throw new Error('宿主无法开始游戏')
  }

  async waitForLanguageDismissed(signal: AbortSignal): Promise<void> {
    const gone = await this.request('wait-language', undefined, signal)
    if (gone !== true) throw new Error('游戏没有离开当前画面')
  }

  private request(
    kind: StageAction['kind'],
    text: string | undefined,
    signal: AbortSignal
  ): Promise<unknown> {
    const session = sessions.get(this.pageId)
    if (!session || session.origin !== this.origin || signal.aborted) {
      return Promise.reject(new Error('宿主无法开始游戏'))
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const action: StageAction = { kind, text, resolve, reject }
    const onAbort = (): void => {
      remove(session, action)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const finish = (value: unknown, error?: Error): void => {
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    action.resolve = (value) => finish(value)
    action.reject = (error) => finish(undefined, error)
    session.actions.push(action)
    return promise
  }

  private sessionSignal(): AbortSignal {
    return sessions.get(this.pageId)?.signal ?? AbortSignal.abort(new Error('宿主无法开始游戏'))
  }
}

async function answerNextAction(
  request: IncomingMessage,
  response: ServerResponse,
  session: StageSession
): Promise<void> {
  const action = await waitForAction(session, request)
  if (!action) {
    writeJson(response, { done: true })
    return
  }
  writeJson(response, { kind: action.kind, text: action.text ?? '' })
}

async function acceptActionResult(
  request: IncomingMessage,
  response: ServerResponse,
  session: StageSession
): Promise<void> {
  const body = await readLimited(request, 20_000)
  let parsed: { ok?: unknown; facts?: unknown } = {}
  try {
    parsed = JSON.parse(body.toString('utf8')) as { ok?: unknown; facts?: unknown }
  } catch {
    writeText(response, 400, '舞台输入结果无效')
    return
  }
  const action = session.active
  session.active = undefined
  if (!action) {
    writeText(response, 409, '舞台输入没有等待中的动作')
    return
  }
  if (action.kind === 'read') action.resolve(screenFacts(parsed.facts))
  else action.resolve(parsed.ok === true)
  writeJson(response, { accepted: true })
}

function waitForAction(
  session: StageSession,
  request: IncomingMessage
): Promise<StageAction | undefined> {
  if (session.active) return Promise.resolve(session.active)
  const queued = session.actions.shift()
  if (queued) {
    session.active = queued
    return Promise.resolve(queued)
  }
  const { promise, resolve } = Promise.withResolvers<StageAction | undefined>()
  const timer = setInterval(() => {
    const next = session.actions.shift()
    if (!next) return
    session.active = next
    finish(next)
  }, 30)
  let settled = false
  const finish = (action?: StageAction): void => {
    if (settled) return
    settled = true
    clearTimeout(expired)
    clearInterval(timer)
    request.off('close', onClose)
    session.signal.removeEventListener('abort', onAbort)
    resolve(action)
  }
  const onClose = (): void => finish()
  const onAbort = (): void => finish()
  const expired = setTimeout(finish, 2000)
  request.once('close', onClose)
  session.signal.addEventListener('abort', onAbort, { once: true })
  return promise
}

function screenFacts(value: unknown): CandidateScreenFacts | null {
  if (!value || typeof value !== 'object') return null
  const facts = value as { languageButtons?: unknown; titleButtons?: unknown }
  return {
    languageButtons: buttonsOf(facts.languageButtons),
    titleButtons: buttonsOf(facts.titleButtons)
  }
}

function buttonsOf(value: unknown): CandidateScreenButton[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const button = item as { text?: unknown; disabled?: unknown }
    if (typeof button.text !== 'string' || button.text.trim() === '') return []
    return [{ text: button.text, x: 0, y: 0, disabled: button.disabled === true }]
  })
}

function failPending(session: StageSession, error: Error): void {
  for (const action of session.actions.splice(0)) action.reject(error)
}

function readLimited(request: IncomingMessage, limit: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  const chunks: Buffer[] = []
  let size = 0
  request.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > limit) {
      reject(new Error('舞台输入结果过大'))
      request.resume()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', reject)
  return promise
}

function writeJson(response: ServerResponse, body: unknown): void {
  const content = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(content.byteLength),
    'Cache-Control': 'no-store'
  })
  response.end(content)
}

function writeText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error('宿主无法开始游戏')
}

function remove(session: StageSession, action: StageAction): void {
  const index = session.actions.indexOf(action)
  if (index >= 0) session.actions.splice(index, 1)
}

export function stageInputPage(origin: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>游戏舞台</title>
  <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#1a162e}</style>
</head>
<body>
  <iframe id="stage" title="游戏舞台" src="${escapeAttribute(origin)}/"></iframe>
  <script>
    const origin = ${JSON.stringify(origin)}
    const frame = document.querySelector('#stage')
    const shown = (element) => {
      const rect = element.getBoundingClientRect()
      const style = frame.contentWindow.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none'
    }
    const viewportReady = () => {
      const view = frame.contentWindow
      const width = view.innerWidth || frame.contentDocument.documentElement.clientWidth
      const height = view.innerHeight || frame.contentDocument.documentElement.clientHeight
      return width > 0 && height > 0
    }
    const gameReady = () => {
      try {
        return frame.contentDocument.readyState === 'complete' && viewportReady()
      } catch {
        return false
      }
    }
    const labelOf = (element) => {
      const raw = String(element.textContent || '').replace(/\\u00a0/g, ' ').trim()
      const words = raw.split(' ').filter(Boolean)
      if (words.length >= 3 && words.length % 3 === 0) {
        const size = words.length / 3
        const one = words.slice(0, size).join(' ')
        if (one === words.slice(size, size * 2).join(' ') && one === words.slice(size * 2).join(' ')) return one
      }
      const compact = words.join('')
      if (compact.length >= 3 && compact.length % 3 === 0) {
        const size = compact.length / 3
        const one = compact.slice(0, size)
        if (one === compact.slice(size, size * 2) && one === compact.slice(size * 2)) return one
      }
      return words.join(' ')
    }
    const buttons = (selector, titleOnly) => [...frame.contentDocument.querySelectorAll(selector)].flatMap((element) => {
      if (!shown(element)) return []
      const name = String(element.className)
      if (titleOnly && (!name.includes('Title_button_') || name.includes('Title_button_text') || name.includes('Title_buttonList') || name.includes('Title_button_disabled') || name.includes('Title_backup'))) return []
      const text = labelOf(element)
      return text ? [{ text, disabled: name.includes('disabled') }] : []
    })
    const facts = () => (gameReady() ? { languageButtons: buttons('[class*="langSelectButton"]', false), titleButtons: buttons('[class*="Title_button"]', true) } : null)
    const clickText = (text) => {
      if (!gameReady()) return false
      const enter = [...frame.contentDocument.querySelectorAll('.title__enter-game-target, .html-body__title-enter')].find((element) => shown(element))
      if (enter && text === '开始游戏') enter.click()
      const element = [...frame.contentDocument.querySelectorAll('[class*="langSelectButton"], [class*="Title_button_"]')].find((item) => labelOf(item) === text && shown(item))
      if (!element) return false
      element.click()
      return true
    }
    const post = async (body) => {
      await fetch(location.pathname + '?result=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const run = async () => {
      while (true) {
        let response
        try {
          response = await fetch(location.pathname + '?next=1')
        } catch {
          await sleep(250)
          continue
        }
        if (response.status === 404) return
        if (!response.ok) {
          await sleep(400)
          continue
        }
        let action
        try {
          action = await response.json()
        } catch {
          await sleep(250)
          continue
        }
        if (action.done) {
          await sleep(150)
          continue
        }
        try {
          if (action.kind === 'read') await post({ facts: facts() })
          else if (action.kind === 'activate') await post({ ok: clickText(action.text) })
          else await post({ ok: frame.contentDocument.querySelector('[class*="langSelectButton"]') === null })
        } catch {
          try {
            await post({ ok: false })
          } catch {}
        }
      }
    }
    let started = false
    const start = () => {
      if (started) return
      started = true
      void run()
    }
    const frameReady = () => {
      try {
        return frame.contentWindow.location.href.startsWith(origin) && frame.contentDocument.readyState === 'complete'
      } catch {
        return false
      }
    }
    frame.addEventListener('load', start)
    if (frameReady()) start()
  </script>
</body>
</html>`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}
