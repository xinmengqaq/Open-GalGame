/**
 * 宿主侧「自制引擎扩展」：在 WebGAL 引擎页面内包装资源管理器，让 `/figure/` 立绘纹理常驻，
 * 避免 sync-scene 重放时被预取回收销毁；不修改 node_modules、不改预览协议。
 * 本模块只提供纯函数、脚本文本与 HTML 注入，不访问文件系统，也不依赖浏览器全局。
 */

/** 扩展脚本版本；脚本行为变化时同步递增。 */
export const ENGINE_EXTENSION_SCRIPT_VERSION = '1'

/** 扩展脚本路由，相对 WebGAL 运行时根提供。 */
export const ENGINE_EXTENSION_SCRIPT_PATH = '/__opengalgame/engine-extension.js'

/** 已人工核对、允许安装扩展的引擎版本。 */
export const DEFAULT_SUPPORTED_ENGINE_VERSIONS: readonly string[] = ['4.6.5']

/** 扩展状态对象在页面里的全局键。 */
export const ENGINE_EXTENSION_STATE_KEY = '__OPENGALGAME_ENGINE_EXT__'

/** 扩展在页面内的安装状态。 */
export type EngineExtensionStatus =
  'waiting' | 'active' | 'active-unsupported-version' | 'feature-missing' | 'failed' | 'disabled'

/** 宿主启用扩展的开关与版本白名单。 */
export interface EngineExtensionOptions {
  /** 默认启用；显式 false 时不注入、扩展路由返回 404。 */
  readonly enabled?: boolean
  /** 允许安装的引擎版本；缺省使用 {@link DEFAULT_SUPPORTED_ENGINE_VERSIONS}。 */
  readonly supportedEngineVersions?: readonly string[]
}

/** 生成扩展脚本地址与标签所需的参数。 */
export interface EngineExtensionScriptOptions extends EngineExtensionOptions {
  /** 当前运行时构建上报的引擎版本。 */
  readonly engineVersion: string
}

/** HTML 注入结果；`injected` 为 false 时 html 保持原样。 */
export interface EngineExtensionInjection {
  readonly html: string
  readonly injected: boolean
}

/**
 * @param options - 扩展开关与版本白名单。
 * @returns 生效的引擎版本白名单。
 */
function supportedVersionsOf(options: EngineExtensionOptions): readonly string[] {
  return options.supportedEngineVersions ?? DEFAULT_SUPPORTED_ENGINE_VERSIONS
}

/**
 * 生成扩展脚本地址：路径固定，query 携带脚本版本、当前引擎版本与版本白名单。
 * @param options - 引擎版本与扩展选项。
 * @returns 以 `/` 开头的扩展脚本地址。
 */
export function buildEngineExtensionScriptUrl(options: EngineExtensionScriptOptions): string {
  const query = new URLSearchParams()
  query.set('v', ENGINE_EXTENSION_SCRIPT_VERSION)
  query.set('engine', options.engineVersion)
  query.set('supported', supportedVersionsOf(options).join(','))
  return `${ENGINE_EXTENSION_SCRIPT_PATH}?${query.toString()}`
}

/**
 * @param options - 引擎版本与扩展选项。
 * @returns 可插入引擎 HTML 的经典脚本标签。
 */
export function buildEngineExtensionScriptTag(options: EngineExtensionScriptOptions): string {
  return `<script src="${buildEngineExtensionScriptUrl(options)}"></script>`
}

/**
 * 把扩展脚本标签插入引擎 HTML 的最后一个 `</body>` 之前；没有 body 时追加到末尾。
 * 已包含扩展路由的同名脚本时不重复插入。
 * @param html - 引擎返回的 HTML 文本。
 * @param tag - 脚本标签；为空（如扩展关闭）时不注入。
 * @returns 注入后的 HTML 与是否实际注入。
 */
export function injectEngineExtensionHtml(
  html: string,
  tag: string | undefined
): EngineExtensionInjection {
  if (!tag) return { html, injected: false }
  if (html.includes(ENGINE_EXTENSION_SCRIPT_PATH)) return { html, injected: false }
  const bodyCloseIndex = html.toLowerCase().lastIndexOf('</body>')
  const injectedHtml =
    bodyCloseIndex >= 0
      ? `${html.slice(0, bodyCloseIndex)}${tag}${html.slice(bodyCloseIndex)}`
      : `${html}${tag}`
  return { html: injectedHtml, injected: true }
}

/**
 * 引擎页面内执行的扩展脚本。经典脚本先于 deferred module 执行，因此能在引擎创建
 * `window.PIXIapp` 之前劫持赋值，并在安装后包装 `assets.wanted()`，把仍被当前场景引用的
 * `/figure/` 纹理加入 wanted 集合，使 `collect()` 不再销毁这些纹理。
 */
export const ENGINE_EXTENSION_SCRIPT: string = `(function () {
  'use strict'
  var STATE_KEY = '__OPENGALGAME_ENGINE_EXT__'
  var SCRIPT_VERSION = '1'
  var SCRIPT_PATH = '/__opengalgame/engine-extension.js'
  var FIGURE_MARKER = '/figure/'
  var POLL_INTERVAL_MS = 100
  var INSTALL_TIMEOUT_MS = 5000
  var MAX_ERRORS = 20

  function readQuery() {
    var script = document.currentScript
    if (!script) {
      var scripts = document.getElementsByTagName('script')
      for (var index = 0; index < scripts.length; index += 1) {
        if (String(scripts[index].src || '').indexOf(SCRIPT_PATH) !== -1) {
          script = scripts[index]
          break
        }
      }
    }
    var source = script && script.src ? String(script.src) : ''
    var mark = source.indexOf('?')
    if (mark === -1) return {}
    var pairs = source.slice(mark + 1).split('&')
    var result = {}
    for (var pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
      var pair = pairs[pairIndex]
      if (!pair) continue
      var equals = pair.indexOf('=')
      var name = equals === -1 ? pair : pair.slice(0, equals)
      var value = equals === -1 ? '' : pair.slice(equals + 1)
      try {
        result[decodeURIComponent(name)] = decodeURIComponent(value)
      } catch (error) {
        result[name] = value
      }
    }
    return result
  }

  var query = readQuery()
  var engineVersion = typeof query.engine === 'string' ? query.engine : 'unknown'
  var supported = []
  if (typeof query.supported === 'string' && query.supported.length > 0) {
    supported = query.supported.split(',').filter(function (item) {
      return item.length > 0
    })
  }

  var state = {
    schema: 1,
    scriptVersion: SCRIPT_VERSION,
    status: 'waiting',
    engineVersion: engineVersion,
    supportedEngineVersions: supported.slice(),
    patchedWanted: false,
    protectedEntryCount: 0,
    wantedCalls: 0,
    installedAt: null,
    errors: [],
    disable: function () {
      disable()
    }
  }
  window[STATE_KEY] = state

  function warn(message) {
    try {
      console.warn('[opengalgame-engine-extension] ' + message)
    } catch (error) {
      return
    }
  }

  function rememberError(message) {
    if (state.errors.length >= MAX_ERRORS) return
    state.errors.push(String(message))
  }

  var installed = false
  var pollTimer = null
  var pollElapsedMs = 0

  function clearPollTimer() {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  function disable() {
    state.status = 'disabled'
    clearPollTimer()
  }

  function markFeatureMissing(message) {
    state.status = 'feature-missing'
    clearPollTimer()
    rememberError(message)
    warn(message)
  }

  function markFailed(message) {
    state.status = 'failed'
    clearPollTimer()
    rememberError(message)
    warn(message)
  }

  function isSupportedVersion() {
    if (supported.length === 0) return true
    for (var index = 0; index < supported.length; index += 1) {
      if (supported[index] === engineVersion) return true
    }
    return false
  }

  function errorText(error) {
    return String(error && error.message ? error.message : error)
  }

  function install(app) {
    if (installed) return
    installed = true
    clearPollTimer()
    var assets = app && app.assets
    var entries = assets && assets.entries
    if (!assets || typeof assets.wanted !== 'function' || !entries || typeof entries.forEach !== 'function') {
      markFeatureMissing('引擎资源管理器结构不匹配：找不到 app.assets.wanted 或 app.assets.entries')
      return
    }
    var originalWanted = assets.wanted
    var wrapper = function () {
      var wanted = originalWanted.apply(this, arguments)
      try {
        if (!wanted || typeof wanted.add !== 'function') {
          rememberError('assets.wanted() 返回值不是 Set，跳过立绘纹理保护')
          return wanted
        }
        var protectedEntries = 0
        entries.forEach(function (entry, key) {
          var request = entry && entry.request
          var url = request && request.url
          if (typeof url !== 'string' || url.indexOf(FIGURE_MARKER) === -1) return
          wanted.add(key)
          protectedEntries += 1
          var dependencies = entry.dependencies
          if (dependencies && typeof dependencies.forEach === 'function') {
            dependencies.forEach(function (dependency) {
              wanted.add(dependency)
            })
          }
        })
        state.wantedCalls += 1
        state.protectedEntryCount = protectedEntries
      } catch (error) {
        rememberError('立绘纹理保护失败：' + errorText(error))
      }
      return wanted
    }
    assets.wanted = wrapper
    state.patchedWanted = true
    state.installedAt = Date.now()
    state.disable = function () {
      if (assets.wanted === wrapper) assets.wanted = originalWanted
      state.patchedWanted = false
      state.status = 'disabled'
      clearPollTimer()
    }
    if (isSupportedVersion()) {
      state.status = 'active'
      return
    }
    state.status = 'active-unsupported-version'
    warn(
      '引擎版本 ' + engineVersion + ' 不在已核对列表 ' + supported.join(',') + ' 中；扩展已安装，仅做立绘纹理保护'
    )
  }

  function startPoll() {
    if (pollTimer !== null) return
    pollElapsedMs = 0
    pollTimer = setInterval(function () {
      pollElapsedMs += POLL_INTERVAL_MS
      if (installed) {
        clearPollTimer()
        return
      }
      var app = window.PIXIapp
      if (app) {
        install(app)
        return
      }
      if (pollElapsedMs >= INSTALL_TIMEOUT_MS) {
        markFeatureMissing('等待 window.PIXIapp 超过 ' + INSTALL_TIMEOUT_MS + 'ms，扩展未启用')
      }
    }, POLL_INTERVAL_MS)
  }

  function watchPixiApp() {
    var existing = window.PIXIapp
    if (existing) {
      install(existing)
      return
    }
    var value
    try {
      Object.defineProperty(window, 'PIXIapp', {
        configurable: true,
        enumerable: true,
        get: function () {
          return value
        },
        set: function (next) {
          value = next
          try {
            install(next)
          } catch (error) {
            markFailed('安装扩展失败：' + errorText(error))
          }
        }
      })
    } catch (error) {
      rememberError('无法劫持 window.PIXIapp：' + errorText(error))
      startPoll()
      return
    }
    startPoll()
  }

  try {
    watchPixiApp()
  } catch (error) {
    markFailed('扩展初始化失败：' + errorText(error))
  }
})()
`
