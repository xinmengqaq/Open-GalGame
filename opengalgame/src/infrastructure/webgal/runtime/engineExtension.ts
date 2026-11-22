import { WEBGAL_AUDITED_VERSION } from '@common/config/WebgalVersion'


export const ENGINE_EXTENSION_SCRIPT_VERSION = '2'

export const ENGINE_EXTENSION_SCRIPT_PATH = '/__opengalgame/engine-extension.js'

export const DEFAULT_SUPPORTED_ENGINE_VERSIONS: readonly string[] = [WEBGAL_AUDITED_VERSION]

export const ENGINE_EXTENSION_STATE_KEY = '__OPENGALGAME_ENGINE_EXT__'

export interface EngineExtensionOptions {
  readonly enabled?: boolean
  readonly supportedEngineVersions?: readonly string[]
  /**
   * 受限自动开始：仅在预览运行时显式启用。
   * 页面内一次性激活落地页、语言选择和真实「开始游戏」控件，加载 start.txt；
   * 不注入剧情、不发送坐标、不抢焦点，未显式启用时保持引擎原本的标题流程。
   */
  readonly autoStart?: boolean
}

export interface EngineExtensionScriptOptions extends EngineExtensionOptions {
  readonly engineVersion: string
}

export interface EngineExtensionInjection {
  readonly html: string
  readonly injected: boolean
}

function supportedVersionsOf(options: EngineExtensionOptions): readonly string[] {
  return options.supportedEngineVersions ?? DEFAULT_SUPPORTED_ENGINE_VERSIONS
}

export function buildEngineExtensionScriptUrl(options: EngineExtensionScriptOptions): string {
  const query = new URLSearchParams()
  query.set('v', ENGINE_EXTENSION_SCRIPT_VERSION)
  query.set('engine', options.engineVersion)
  query.set('supported', supportedVersionsOf(options).join(','))
  if (options.autoStart === true) query.set('start', '1')
  return `${ENGINE_EXTENSION_SCRIPT_PATH}?${query.toString()}`
}

export function buildEngineExtensionScriptTag(options: EngineExtensionScriptOptions): string {
  return `<script src="${buildEngineExtensionScriptUrl(options)}"></script>`
}

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

  var AUTO_START_TICK_MS = 100
  var AUTO_START_TIMEOUT_MS = 10000
  var AUTO_START_WATCH_MS = 2000
  var LANGUAGE_GRACE_MS = 300
  var LANGUAGE_STUCK_MS = 1500
  var START_CONTROL_WAIT_MS = 1000
  var START_LABELS = [
    '开始游戏',
    '開始遊戲',
    'START',
    '初めから',
    'COMMENCER',
    'STARTEN',
    'INICIAR',
    '게임시작하기'
  ]
  var autoStartEnabled = query.start === '1'
  var startState = {
    enabled: autoStartEnabled,
    status: autoStartEnabled ? 'waiting' : 'off',
    clickedLanding: false,
    clickedLanguage: false,
    clickedStart: false,
    clicks: [],
    lastClickAt: null,
    startedAt: null,
    errors: []
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
    start: startState,
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
    stopAutoStart()
    if (autoStartEnabled && startState.status !== 'started') startState.status = 'disabled'
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

  var startTimer = null
  var startStopped = false
  var startBeganAt = 0
  var startTitleSeenAt = 0
  var startLanguageClickedAt = 0

  function stopAutoStart() {
    startStopped = true
    if (startTimer === null) return
    clearInterval(startTimer)
    startTimer = null
  }

  function rememberStartError(kind, error) {
    var message = '自动开始 ' + kind + ' 失败：' + errorText(error)
    if (startState.errors.length < MAX_ERRORS) startState.errors.push(message)
    rememberError(message)
  }

  function markStartClick(kind) {
    if (kind === 'landing') startState.clickedLanding = true
    else if (kind === 'language') startState.clickedLanguage = true
    else if (kind === 'start') startState.clickedStart = true
    startState.clicks.push(kind)
    startState.lastClickAt = Date.now()
  }

  function languageButtonList() {
    var nodes = document.querySelectorAll('[class*="langSelectButton"]')
    var result = []
    if (!nodes) return result
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]
      if (!node) continue
      var inlineStyle = node.style || {}
      if (inlineStyle.display === 'none' || inlineStyle.visibility === 'hidden') continue
      result.push(node)
    }
    return result
  }

  function preferredLanguageButton(buttons) {
    if (buttons.length === 0) return null
    for (var index = 0; index < buttons.length; index += 1) {
      var text = String((buttons[index] && buttons[index].textContent) || '')
      if (text.indexOf('简体中文') !== -1) return buttons[index]
    }
    return buttons[0]
  }

  function startButtonOf(list) {
    var children = (list && list.children) || []
    for (var index = 0; index < children.length; index += 1) {
      var child = children[index]
      var name = String((child && child.className) || '')
      if (name.indexOf('Title_button_') === -1) continue
      if (name.indexOf('Title_button_disabled') !== -1) continue
      if (name.indexOf('Title_button_text') !== -1) continue
      var text = String((child && child.textContent) || '').replace(/[\s\u00a0]+/g, '')
      if (text === '') continue
      for (var labelIndex = 0; labelIndex < START_LABELS.length; labelIndex += 1) {
        var label = START_LABELS[labelIndex]
        if (text.indexOf(label) === 0) return child
      }
    }
    return null
  }

  function languageStored() {
    try {
      return !!window.localStorage && window.localStorage.getItem('lang') !== null
    } catch (error) {
      return false
    }
  }

  function clickStartLanguage(button, now) {
    if (!button) return false
    try {
      button.click()
      markStartClick('language')
      startLanguageClickedAt = now
      startState.status = 'language'
      return true
    } catch (error) {
      rememberStartError('language', error)
      startState.status = 'failed'
      stopAutoStart()
      return false
    }
  }

  function autoStartTick() {
    if (!autoStartEnabled || startStopped) return
    var now = Date.now()
    if (startBeganAt === 0) startBeganAt = now
    if (startState.clickedStart) {
      var lateButtons = languageButtonList()
      if (lateButtons.length > 0 && !startState.clickedLanguage) {
        clickStartLanguage(preferredLanguageButton(lateButtons), now)
        return
      }
      if (now - (startState.startedAt || now) < AUTO_START_WATCH_MS) return
      if (
        document.querySelector('[class*="Title_buttonList"]') &&
        startState.status === 'started'
      ) {
        startState.status = 'start-unconfirmed'
        warn('点击开始游戏后标题层仍在，未再次点击')
      }
      stopAutoStart()
      return
    }
    if (now - startBeganAt > AUTO_START_TIMEOUT_MS) {
      startState.status = 'timeout'
      stopAutoStart()
      warn('自动开始超时：没有找到可用的落地页或开始控件')
      return
    }
    var landing = document.querySelector('.html-body__title-enter')
    if (
      landing &&
      !startState.clickedLanding &&
      (!landing.style || landing.style.display !== 'none') &&
      typeof landing.onclick === 'function'
    ) {
      try {
        landing.click()
        markStartClick('landing')
        startState.status = 'entering'
      } catch (error) {
        rememberStartError('landing', error)
      }
    }
    var languageButtons = languageButtonList()
    if (languageButtons.length > 0) {
      if (!startState.clickedLanguage) {
        clickStartLanguage(preferredLanguageButton(languageButtons), now)
        return
      }
      if (
        startLanguageClickedAt !== 0 &&
        now - startLanguageClickedAt > LANGUAGE_STUCK_MS
      ) {
        startState.status = 'language-stuck'
        stopAutoStart()
        warn('语言选择点击后仍未关闭，停止自动开始')
      }
      return
    }
    var list = document.querySelector('[class*="Title_buttonList"]')
    if (!list) return
    if (startTitleSeenAt === 0) startTitleSeenAt = now
    if (!languageStored() && now - startTitleSeenAt < LANGUAGE_GRACE_MS) return
    var startButton = startButtonOf(list)
    if (!startButton) {
      if (startTitleSeenAt !== 0 && now - startTitleSeenAt > START_CONTROL_WAIT_MS) {
        startState.status = 'start-control-missing'
        stopAutoStart()
        warn('标题页没有找到已核对的开始游戏控件，未点击其他按钮')
      }
      return
    }
    try {
      startButton.click()
      markStartClick('start')
      startState.status = 'started'
      startState.startedAt = now
    } catch (error) {
      rememberStartError('start', error)
      startState.status = 'failed'
      stopAutoStart()
    }
  }

  function startAutoStart() {
    if (!autoStartEnabled) return
    if (!isSupportedVersion()) {
      startState.status = 'unsupported'
      warn('自动开始仅在已核对版本启用')
      return
    }
    if (startTimer !== null) return
    startTimer = setInterval(autoStartTick, AUTO_START_TICK_MS)
    autoStartTick()
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

  try {
    startAutoStart()
  } catch (error) {
    rememberStartError('init', error)
    startState.status = 'failed'
    stopAutoStart()
  }
})()
`
