import type { BrowserWindow, WebFrameMain } from 'electron'

import type {
  CandidateScreenFacts,
  CandidateTrustedInput,
  CandidateTrustedInputSource
} from './candidateGameStart'

const SCREEN_FACTS = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const buttonOf = (element) => {
    const rect = element.getBoundingClientRect()
    return {
      text: String(element.textContent || '').replace(/\\s+/g, ' ').trim(),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      disabled: String(element.className).includes('disabled')
    }
  }
  const languageButtons = [...document.querySelectorAll('[class*="langSelectButton"]')]
    .filter(visible)
    .map(buttonOf)
  const titleButtons = [...document.querySelectorAll('[class*="Title_button"]')]
    .filter((element) => {
      const name = String(element.className)
      return visible(element) && name.includes('Title_button_') && !name.includes('Title_button_text') && !name.includes('Title_buttonList') && !name.includes('Title_button_disabled') && !name.includes('Title_backup')
    })
    .map(buttonOf)
  return { languageButtons, titleButtons }
})()`

/**
 * 通过 Electron 的真实输入事件点击语言或标题按钮。
 * 只读取按钮位置，不调用引擎内部函数，也不使用页面内的 dispatchEvent。
 */
export function createElectronCandidateTrustedInput(
  getWindow: () => BrowserWindow | null
): CandidateTrustedInputSource {
  return ({ stageUrl, signal }) => {
    let origin: string
    try {
      const url = new URL(stageUrl)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null
      origin = url.origin
    } catch {
      return null
    }
    return new ElectronCandidateTrustedInput(getWindow, origin, signal)
  }
}

class ElectronCandidateTrustedInput implements CandidateTrustedInput {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly origin: string,
    private readonly sessionSignal: AbortSignal
  ) {}

  async readScreen(signal: AbortSignal): Promise<CandidateScreenFacts | null> {
    const frame = await this.frame(signal)
    const window = this.window()
    if (!frame || !window) return null
    const facts = (await frame.executeJavaScript(SCREEN_FACTS, false)) as CandidateScreenFacts
    const offset = (await window.webContents.executeJavaScript(
      offsetScript(this.origin),
      false
    )) as { x?: unknown; y?: unknown } | null
    if (!offset || typeof offset.x !== 'number' || typeof offset.y !== 'number') return null
    return {
      languageButtons: shift(facts?.languageButtons, offset.x, offset.y),
      titleButtons: shift(facts?.titleButtons, offset.x, offset.y)
    }
  }

  async click(target: { readonly x: number; readonly y: number }): Promise<void> {
    const window = this.window()
    if (!window) throw new Error('宿主无法开始游戏')
    const x = Math.round(target.x)
    const y = Math.round(target.y)
    window.focus()
    window.webContents.focus()
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }

  async waitForLanguageDismissed(signal: AbortSignal): Promise<void> {
    const frame = await this.frame(signal)
    if (!frame) throw new Error('宿主无法开始游戏')
    await Promise.race([
      frame.executeJavaScript(
        `new Promise((resolve) => {
          const gone = () => document.querySelector('[class*="langSelectButton"]') === null
          if (gone()) { resolve(true); return }
          const observer = new MutationObserver(() => {
            if (!gone()) return
            observer.disconnect()
            resolve(true)
          })
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
        })`,
        false
      ),
      abortPromise(signal)
    ])
  }

  private window(): BrowserWindow | null {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
    return window
  }

  private frame(signal: AbortSignal): Promise<WebFrameMain | null> {
    const window = this.window()
    if (!window) return Promise.resolve(null)
    const existing = findFrame(window.webContents.mainFrame, this.origin)
    if (existing) return Promise.resolve(existing)
    if (signal.aborted || this.sessionSignal.aborted) return Promise.resolve(null)
    const { promise, resolve } = Promise.withResolvers<WebFrameMain | null>()
    let settled = false
    const finish = (frame: WebFrameMain | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(frame)
    }
    const look = (): void => {
      const live = this.window()
      if (!live) {
        finish(null)
        return
      }
      const frame = findFrame(live.webContents.mainFrame, this.origin)
      if (frame) finish(frame)
    }
    const onAbort = (): void => finish(null)
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      window.webContents.removeListener('did-frame-finish-load', look)
      window.webContents.removeListener('did-finish-load', look)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    window.webContents.on('did-frame-finish-load', look)
    window.webContents.on('did-finish-load', look)
    return promise
  }
}

function findFrame(frame: WebFrameMain, origin: string): WebFrameMain | undefined {
  if (frame.url.startsWith(origin)) return frame
  for (const child of frame.frames) {
    const found = findFrame(child, origin)
    if (found) return found
  }
  return undefined
}

function shift(
  buttons: readonly CandidateScreenFacts['languageButtons'][number][] | undefined,
  offsetX: number,
  offsetY: number
): CandidateScreenFacts['languageButtons'] {
  if (!Array.isArray(buttons)) return []
  return buttons.flatMap((button) => {
    if (!button || typeof button.text !== 'string') return []
    if (typeof button.x !== 'number' || typeof button.y !== 'number') return []
    return [
      {
        text: button.text,
        x: button.x + offsetX,
        y: button.y + offsetY,
        disabled: button.disabled === true
      }
    ]
  })
}

function offsetScript(origin: string): string {
  return `(() => {
    const origin = ${JSON.stringify(origin)}
    const frame = [...document.querySelectorAll('iframe')].find((element) => {
      try { return new URL(element.src).origin === origin } catch { return false }
    })
    if (!frame) return null
    const rect = frame.getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })()`
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  const { promise, reject } = Promise.withResolvers<never>()
  signal.addEventListener('abort', () => reject(abortError(signal)), { once: true })
  return promise
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error('等待 WebGAL 舞台状态超时')
}
