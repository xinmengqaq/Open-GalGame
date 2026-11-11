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

interface ExtensionState {
  readonly status: string
  readonly engineVersion: string
  readonly supportedEngineVersions: readonly string[]
  readonly patchedWanted: boolean
  readonly protectedEntryCount: number
  readonly wantedCalls: number
  readonly installedAt: number | null
  readonly errors: readonly string[]
  disable(): void
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

/**
 * @param engineVersion - 脚本地址里上报的引擎版本。
 * @returns 供 `runInNewContext` 使用的脚本地址参数。
 */
function scriptSrcOf(engineVersion: string): string {
  return `http://runtime${ENGINE_EXTENSION_SCRIPT_PATH}?v=${ENGINE_EXTENSION_SCRIPT_VERSION}&engine=${engineVersion}&supported=${DEFAULT_SUPPORTED_ENGINE_VERSIONS.join(',')}`
}

/**
 * 在独立 vm 上下文中加载扩展脚本，并暴露页面侧状态与可手动推进的定时器。
 * @param engineVersion - 脚本地址里上报的引擎版本。
 * @returns 页面 window、状态对象、定时器推进函数与警告收集。
 */
function loadExtension(engineVersion = '4.6.5'): {
  readonly window: Record<string, unknown>
  readonly state: ExtensionState
  readonly warnings: readonly string[]
  runTimers(times: number): void
} {
  const timers = new Map<number, () => void>()
  let nextTimerId = 0
  const window: Record<string, unknown> = {}
  const warnings: string[] = []
  const document = {
    currentScript: { src: scriptSrcOf(engineVersion) },
    baseURI: 'http://runtime/',
    getElementsByTagName: (): readonly unknown[] => []
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

/**
 * @returns 只含真实引擎资源管理器关键结构的假 app。
 */
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
})
