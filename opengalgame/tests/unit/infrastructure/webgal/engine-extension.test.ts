import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import {
  buildEngineExtensionScriptTag,
  buildEngineExtensionScriptUrl,
  DEFAULT_SUPPORTED_ENGINE_VERSIONS,
  ENGINE_EXTENSION_SCRIPT,
  ENGINE_EXTENSION_SCRIPT_PATH,
  ENGINE_EXTENSION_SCRIPT_VERSION,
  ENGINE_EXTENSION_STATE_KEY,
  injectEngineExtensionHtml
} from '@infrastructure/webgal/runtime/engineExtension'

interface ExtensionStartState {
  readonly enabled: boolean
  status: string
  readonly clickedLanding: boolean
  readonly clickedLanguage: boolean
  readonly clickedStart: boolean
  readonly clicks: readonly string[]
}

interface ExtensionState {
  readonly status: string
  readonly engineVersion: string
  readonly supportedEngineVersions: readonly string[]
  readonly patchedWanted: boolean
  readonly protectedEntryCount: number
  readonly wantedCalls: number
  readonly installedAt: number | null
  readonly errors: readonly string[]
  readonly start: ExtensionStartState
  disable(): void
}

interface FakeElement {
  readonly className: string
  readonly textContent: string
  readonly style: Record<string, string>
  readonly children: FakeElement[]
  onclick: (() => void) | null
  clickCount: number
  click(): void
}

interface FakeAutoStartDom {
  readonly document: Record<string, unknown>
  readonly landing: FakeElement
  readonly language: FakeElement
  readonly start: FakeElement
  readonly otherButtons: readonly FakeElement[]
}

function fakeElement(className: string, textContent: string): FakeElement {
  return {
    className,
    textContent,
    style: {},
    children: [],
    onclick: null,
    clickCount: 0,
    click(): void {
      this.clickCount += 1
      this.onclick?.()
    }
  }
}

/**
 * @returns 只含自动开始所需真实控件的假页面；语言与标题可以分别消失。
 */
function fakeAutoStartDom(): FakeAutoStartDom {
  const landing = fakeElement('html-body__title-enter', 'PRESS THE SCREEN TO START')
  const language = fakeElement('_langSelectButton_1oupq_40', '简体中文')
  const continueButton = fakeElement('_Title_button_1jbo0_8', '继续游戏继续游戏继续游戏')
  const optionsButton = fakeElement('_Title_button_1jbo0_8', '选项选项选项')
  const exitButton = fakeElement('_Title_button_1jbo0_8', '返回返回返回')
  const start = fakeElement('_Title_button_1jbo0_8', '开始游戏开始游戏开始游戏')
  const list = fakeElement('_Title_buttonList_1jbo0_8', '')
  list.children.push(continueButton, optionsButton, start, exitButton)
  let languageVisible = true
  let titleVisible = true
  landing.onclick = (): void => {
    landing.style.display = 'none'
  }
  language.onclick = (): void => {
    languageVisible = false
  }
  start.onclick = (): void => {
    titleVisible = false
  }
  const document = {
    baseURI: 'http://runtime/',
    getElementsByTagName: (): readonly unknown[] => [],
    querySelector(selector: string): FakeElement | null {
      if (selector === '.html-body__title-enter') return landing
      if (selector === '[class*="Title_buttonList"]') return titleVisible ? list : null
      return null
    },
    querySelectorAll(selector: string): readonly FakeElement[] {
      if (selector === '[class*="langSelectButton"]') return languageVisible ? [language] : []
      return []
    }
  }
  return {
    document,
    landing,
    language,
    start,
    otherButtons: [continueButton, optionsButton, exitButton]
  }
}

interface FakeAssetEntry {
  readonly request: { readonly url: string }
  readonly dependencies: Set<string>
}

interface FakeAssetManager {
  readonly entries: Map<string, FakeAssetEntry>
  wanted(): Set<string>
}

interface FakeAssetsApp {
  readonly assets: FakeAssetManager
}

const figureKey = 'texture:http://runtime/game/figure/a.png'
const figureDependency = 'texture:http://runtime/game/figure/dependency.png'
const backgroundKey = 'texture:http://runtime/game/background/b.jpg'

function scriptSrcOf(engineVersion: string, autoStart = false): string {
  const query = `v=${ENGINE_EXTENSION_SCRIPT_VERSION}&engine=${engineVersion}&supported=${DEFAULT_SUPPORTED_ENGINE_VERSIONS.join(',')}`
  return `http://runtime${ENGINE_EXTENSION_SCRIPT_PATH}?${query}${autoStart ? '&start=1' : ''}`
}

function loadExtension(
  engineVersion = '4.6.5',
  options: {
    readonly autoStart?: boolean
    readonly document?: Record<string, unknown>
    readonly window?: Record<string, unknown>
  } = {}
): {
  readonly window: Record<string, unknown>
  readonly state: ExtensionState
  readonly warnings: readonly string[]
  runTimers(times: number): void
} {
  const timers = new Map<number, () => void>()
  let nextTimerId = 0
  const window: Record<string, unknown> = { ...options.window }
  const warnings: string[] = []
  const document = {
    currentScript: { src: scriptSrcOf(engineVersion, options.autoStart === true) },
    baseURI: 'http://runtime/',
    getElementsByTagName: (): readonly unknown[] => [],
    ...options.document
  }
  runInNewContext(ENGINE_EXTENSION_SCRIPT, {
    window,
    document,
    console: {
      warn: (message: unknown): void => {
        warnings.push(String(message))
      }
    },
    Date,
    setInterval: (callback: () => void): number => {
      nextTimerId += 1
      timers.set(nextTimerId, callback)
      return nextTimerId
    },
    clearInterval: (timerId: number): void => {
      timers.delete(timerId)
    }
  })
  const state = window[ENGINE_EXTENSION_STATE_KEY] as unknown as ExtensionState
  return {
    window,
    state,
    warnings,
    runTimers(times: number): void {
      const callbacks = [...timers.values()]
      for (let index = 0; index < times; index += 1) {
        for (const callback of callbacks) callback()
      }
    }
  }
}

function fakeApp(): FakeAssetsApp {
  const entries = new Map<string, FakeAssetEntry>([
    [
      figureKey,
      {
        request: { url: 'http://runtime/game/figure/a.png' },
        dependencies: new Set([figureDependency])
      }
    ],
    [
      backgroundKey,
      {
        request: { url: 'http://runtime/game/background/b.jpg' },
        dependencies: new Set()
      }
    ]
  ])
  return {
    assets: {
      entries,
      wanted: (): Set<string> => new Set([backgroundKey])
    }
  }
}

describe('自制引擎扩展脚本', () => {
  it('脚本地址携带脚本版本、引擎版本与版本白名单', () => {
    const url = buildEngineExtensionScriptUrl({ engineVersion: '4.6.5' })
    expect(url.startsWith(`${ENGINE_EXTENSION_SCRIPT_PATH}?`)).toBe(true)
    const query = new URL(`http://runtime${url}`).searchParams
    expect(query.get('v')).toBe(ENGINE_EXTENSION_SCRIPT_VERSION)
    expect(query.get('engine')).toBe('4.6.5')
    expect(query.get('supported')).toBe(DEFAULT_SUPPORTED_ENGINE_VERSIONS.join(','))

    const custom = buildEngineExtensionScriptUrl({
      engineVersion: '4.6.6',
      supportedEngineVersions: ['4.6.5', '4.6.6']
    })
    expect(new URL(`http://runtime${custom}`).searchParams.get('supported')).toBe('4.6.5,4.6.6')
    expect(new URL(`http://runtime${custom}`).searchParams.get('start')).toBeNull()
    const autoStart = buildEngineExtensionScriptUrl({ engineVersion: '4.6.5', autoStart: true })
    expect(new URL(`http://runtime${autoStart}`).searchParams.get('start')).toBe('1')
  })

  it('脚本标签使用与地址一致的 src', () => {
    const tag = buildEngineExtensionScriptTag({ engineVersion: '4.6.5' })
    expect(tag).toBe(
      `<script src="${buildEngineExtensionScriptUrl({ engineVersion: '4.6.5' })}"></script>`
    )
  })

  it('把脚本插入最后一个 body 结束标签之前，保留原内容', () => {
    const tag = buildEngineExtensionScriptTag({ engineVersion: '4.6.5' })
    const html = '<html><body><main>scene</main></body></html>'
    const injected = injectEngineExtensionHtml(html, tag)
    expect(injected.injected).toBe(true)
    expect(injected.html).toContain(tag)
    expect(injected.html.indexOf(tag)).toBeLessThan(injected.html.lastIndexOf('</body>'))
    expect(injected.html.replace(tag, '')).toBe(html)
  })

  it('没有 body 时追加到末尾', () => {
    const tag = buildEngineExtensionScriptTag({ engineVersion: '4.6.5' })
    const html = '<main>scene</main>'
    expect(injectEngineExtensionHtml(html, tag).html).toBe(`${html}${tag}`)
  })

  it('已经包含扩展脚本时不再重复插入', () => {
    const tag = buildEngineExtensionScriptTag({ engineVersion: '4.6.5' })
    const html = '<html><body><main>scene</main></body></html>'
    const first = injectEngineExtensionHtml(html, tag)
    const second = injectEngineExtensionHtml(first.html, tag)
    expect(second.injected).toBe(false)
    expect(second.html).toBe(first.html)
  })

  it('没有标签时不注入', () => {
    const html = '<html><body><main>scene</main></body></html>'
    expect(injectEngineExtensionHtml(html, undefined)).toEqual({ html, injected: false })
  })

  it('脚本文本包含状态键与安装/降级标记', () => {
    expect(ENGINE_EXTENSION_SCRIPT).toContain(ENGINE_EXTENSION_STATE_KEY)
    expect(ENGINE_EXTENSION_SCRIPT).toContain('PIXIapp')
    expect(ENGINE_EXTENSION_SCRIPT).toContain('wanted')
    expect(ENGINE_EXTENSION_SCRIPT).toContain('/figure/')
    expect(ENGINE_EXTENSION_SCRIPT).toContain('feature-missing')
    expect(ENGINE_EXTENSION_SCRIPT).toContain('active-unsupported-version')
    expect(ENGINE_EXTENSION_SCRIPT).toContain('disable')
    expect(ENGINE_EXTENSION_SCRIPT).toContain('console.warn')
  })

  it('安装后包装 wanted，把立绘纹理及其依赖加入保留集合', () => {
    const loaded = loadExtension()
    const app = fakeApp()
    expect(loaded.state.status).toBe('waiting')
    loaded.window.PIXIapp = app
    expect(loaded.state.status).toBe('active')
    expect(loaded.state.patchedWanted).toBe(true)
    expect(loaded.state.installedAt).toEqual(expect.any(Number))

    const wanted = app.assets.wanted()
    expect(wanted.has(figureKey)).toBe(true)
    expect(wanted.has(figureDependency)).toBe(true)
    expect(wanted.has(backgroundKey)).toBe(true)
    expect(loaded.state.wantedCalls).toBe(1)
    expect(loaded.state.protectedEntryCount).toBe(1)
  })

  it('disable() 恢复原 wanted 并把状态标为 disabled', () => {
    const loaded = loadExtension()
    const app = fakeApp()
    loaded.window.PIXIapp = app
    loaded.state.disable()
    expect(loaded.state.status).toBe('disabled')
    expect(loaded.state.patchedWanted).toBe(false)
    expect(app.assets.wanted().has(figureKey)).toBe(false)
  })

  it('引擎版本不在支持列表时仍安装，但状态标记为不受支持', () => {
    const loaded = loadExtension('4.6.6')
    loaded.window.PIXIapp = fakeApp()
    expect(loaded.state.status).toBe('active-unsupported-version')
    expect(loaded.state.patchedWanted).toBe(true)
    expect(loaded.warnings.join('\n')).toContain('不在已核对列表')
  })

  it('资源管理器结构缺失时标记 feature-missing 并告警', () => {
    const loaded = loadExtension()
    loaded.window.PIXIapp = {}
    expect(loaded.state.status).toBe('feature-missing')
    expect(loaded.state.patchedWanted).toBe(false)
    expect(loaded.warnings.length).toBeGreaterThan(0)
  })

  it('window.PIXIapp 超时未出现时标记 feature-missing', () => {
    const loaded = loadExtension()
    loaded.runTimers(50)
    expect(loaded.state.status).toBe('feature-missing')
    expect(loaded.warnings.join('\n')).toContain('超过 5000ms')
  })

  it('启用受限自动开始时依次点击落地页、语言和真实开始控件各一次', () => {
    const dom = fakeAutoStartDom()
    const loaded = loadExtension('4.6.5', {
      autoStart: true,
      document: dom.document,
      window: { localStorage: { getItem: (): string => '0' } }
    })
    expect(loaded.state.start.enabled).toBe(true)
    expect(dom.landing.clickCount).toBe(1)
    expect(dom.language.clickCount).toBe(1)
    expect(dom.start.clickCount).toBe(0)

    loaded.runTimers(1)
    expect(dom.start.clickCount).toBe(1)
    expect(loaded.state.start.status).toBe('started')
    expect(loaded.state.start.clicks).toEqual(['landing', 'language', 'start'])
    expect(dom.otherButtons.map((button) => button.clickCount)).toEqual([0, 0, 0])

    loaded.runTimers(5)
    expect(dom.landing.clickCount).toBe(1)
    expect(dom.language.clickCount).toBe(1)
    expect(dom.start.clickCount).toBe(1)
  })

  it('标题页有多个按钮时只点击已核对的开始游戏控件', () => {
    const dom = fakeAutoStartDom()
    const loaded = loadExtension('4.6.5', {
      autoStart: true,
      document: dom.document,
      window: { localStorage: { getItem: (): string => '0' } }
    })
    loaded.runTimers(3)
    expect(dom.start.clickCount).toBe(1)
    for (const button of dom.otherButtons) expect(button.clickCount).toBe(0)
    expect(loaded.state.start.clicks).toEqual(['landing', 'language', 'start'])
  })

  it('未显式启用自动时不触碰页面控件', () => {
    const dom = fakeAutoStartDom()
    const loaded = loadExtension('4.6.5', {
      document: dom.document,
      window: { localStorage: { getItem: (): string => '0' } }
    })
    loaded.runTimers(5)
    expect(dom.landing.clickCount).toBe(0)
    expect(dom.language.clickCount).toBe(0)
    expect(dom.start.clickCount).toBe(0)
    expect(loaded.state.start.status).toBe('off')
  })

  it('未核对版本不执行自动开始', () => {
    const dom = fakeAutoStartDom()
    const loaded = loadExtension('4.6.6', {
      autoStart: true,
      document: dom.document,
      window: { localStorage: { getItem: (): string => '0' } }
    })
    loaded.runTimers(5)
    expect(loaded.state.start.status).toBe('unsupported')
    expect(dom.landing.clickCount).toBe(0)
    expect(dom.start.clickCount).toBe(0)
    expect(loaded.warnings.join('\n')).toContain('已核对版本')
  })

  it('disable() 停止后续自动开始点击', () => {
    const dom = fakeAutoStartDom()
    const loaded = loadExtension('4.6.5', {
      autoStart: true,
      document: dom.document,
      window: { localStorage: { getItem: (): string => '0' } }
    })
    loaded.state.disable()
    loaded.runTimers(5)
    expect(dom.start.clickCount).toBe(0)
    expect(loaded.state.start.status).toBe('disabled')
  })
})
