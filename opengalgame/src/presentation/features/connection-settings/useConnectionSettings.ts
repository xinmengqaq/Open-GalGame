import { useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ConnectionSettingsDTO } from '@application/settings/connections/dto/ConnectionSettingsDTO'
import type { ConnectionSettingsVO } from '@application/settings/connections/vo/ConnectionSettingsVO'
import type { ConnectionSettingsClient } from '@interfaces/settings/connections/client/ConnectionSettingsClient'
import { connectionActionFingerprint } from './connectionActionFacts'
import {
  connectionFailureActionHint,
  connectionFailureDiagnostic
} from './connectionFailureDiagnostics'
import {
  buildConnectionSettingsRequest,
  buildListModelsRequest,
  connectionConfigFingerprint,
  connectionExtensionFingerprint,
  connectionExtensionReducer,
  connectionExtensionRequest,
  emptyConnectionExtensionDraft,
  type ConnectionDraftFields,
  type ConnectionExtensionMode
} from './connectionDraft'

const DEFAULT_CONTEXT_WINDOW = '128000'
const DEFAULT_MAX_OUTPUT_TOKENS = '32768'

const TEST_TOAST_ID = 'connection-test-result'
const LIST_TOAST_ID = 'connection-list-result'
const SAVE_FAILURE_TOAST_ID = 'connection-save-failure'
const SAVE_SUCCESS_TOAST_ID = 'connection-save-success'
const LOAD_FAILURE_TOAST_ID = 'connection-load-failure'

export type SettingsViewState = 'closed' | 'loading' | 'editing' | 'testing' | 'saving' | 'listing'

export type SettingsSummarySource = 'saved' | 'session' | 'empty'

function dismissFlowToasts(): void {
  toast.dismiss(TEST_TOAST_ID)
  toast.dismiss(LIST_TOAST_ID)
  toast.dismiss(SAVE_FAILURE_TOAST_ID)
}

function dismissActionToasts(): void {
  dismissFlowToasts()
  toast.dismiss(SAVE_SUCCESS_TOAST_ID)
}

function failureToastDescription(
  message: string,
  code: number,
  reason: string | undefined
): string {
  if (code === ErrorCodes.communicationFailed) {
    return '本地设置服务暂时不可用，请重试。'
  }
  const label = connectionFailureDiagnostic(code, reason).label
  const head = message === label ? message : `${message}（${label}）`
  const hint = connectionFailureActionHint(code, reason)
  return hint === null ? head : `${head}\n${hint}`
}

export interface SettingsFlow {
  state: SettingsViewState
  loadError: string | null
  dirty: boolean
  providerId: ConnectionSettingsDTO['providerId']
  baseUrl: string
  model: string
  apiKey: string
  contextWindow: string
  maxOutputTokens: string
  temperature: string
  topP: string
  hasApiKey: boolean
  hasExtension: boolean
  extensionDraft: string
  extensionEditorOpen: boolean
  extensionMode: ConnectionExtensionMode
  extensionClearConfirming: boolean
  models: string[]
  summarySource: SettingsSummarySource
  setProviderId: (value: ConnectionSettingsDTO['providerId']) => void
  setBaseUrl: (value: string) => void
  setModel: (value: string) => void
  setApiKey: (value: string) => void
  setContextWindow: (value: string) => void
  setMaxOutputTokens: (value: string) => void
  setTemperature: (value: string) => void
  setTopP: (value: string) => void
  setExtensionDraft: (value: string) => void
  openExtensionEditor: () => void
  closeExtensionEditor: () => void
  requestExtensionClear: () => void
  cancelExtensionClear: () => void
  confirmExtensionClear: () => void
  undoExtensionClear: () => void
  open: () => Promise<void>
  loadForSection: () => Promise<void>
  close: () => void
  discardChanges: () => void
  testConnection: () => Promise<void>
  saveSettings: () => Promise<boolean>
  listModels: () => Promise<void>
}

export interface ConnectionSettingsCallbacks {
  /** 连接测试成功；只交出不暴露密钥的配置指纹。 */
  onConnectionTested?: (configFingerprint: string) => void
  /** 连接测试失败；只交出本次草稿指纹。 */
  onConnectionTestFailed?: (configFingerprint: string) => void
  /** 测试过的配置又被改动；只通知失效，不携带草稿内容。 */
  onConnectionChanged?: () => void
  /** 设置保存成功；只交出不暴露密钥的配置指纹。 */
  onConnectionSaved?: (configFingerprint: string) => void
}

export function useConnectionSettings(
  client: ConnectionSettingsClient,
  callbacks: ConnectionSettingsCallbacks = {}
): SettingsFlow {
  const [state, setState] = useState<SettingsViewState>('closed')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providerId, setProviderId] =
    useState<ConnectionSettingsDTO['providerId']>('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW)
  const [maxOutputTokens, setMaxOutputTokens] = useState(DEFAULT_MAX_OUTPUT_TOKENS)
  const [temperature, setTemperature] = useState('')
  const [topP, setTopP] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [listedFingerprint, setListedFingerprint] = useState<string | null>(null)
  const [summarySource, setSummarySource] = useState<SettingsSummarySource>('empty')
  const [baselineSummaryFingerprint, setBaselineSummaryFingerprint] = useState<string | null>(null)
  const [extension, dispatchExtension] = useReducer(
    connectionExtensionReducer,
    emptyConnectionExtensionDraft
  )
  const loadVersion = useRef(0)
  const testVersion = useRef(0)
  const latestFingerprint = useRef('')
  const lastTestedFingerprint = useRef<string | null>(null)
  const lastTestOutcome = useRef<'success' | 'failure' | null>(null)
  const lastSavedSummary = useRef<string | null>(null)
  const lastSummary = useRef<ConnectionSettingsVO | null>(null)

  useEffect(
    () => () => {
      loadVersion.current += 1
      testVersion.current += 1
    },
    []
  )

  const extensionFingerprint = connectionExtensionFingerprint(extension)
  const fingerprint = connectionConfigFingerprint(
    { providerId, baseUrl, model, contextWindow, maxOutputTokens, temperature, topP, apiKey },
    extension
  )
  latestFingerprint.current = fingerprint
  const accessFingerprint = JSON.stringify([providerId, baseUrl, apiKey, extensionFingerprint])
  // 保存后草稿会清空密钥、扩展切回保留态，不能再用带密钥的指纹判断改动；
  // 这里只比对已保存摘要里用户可见的字段。
  const savedSummaryFingerprint = JSON.stringify([
    providerId,
    baseUrl,
    model,
    contextWindow,
    maxOutputTokens,
    temperature,
    topP,
    extension.hasExtension
  ])
  const onConnectionChanged = callbacks.onConnectionChanged

  // 测试或保存过的配置一改，教程必须回到保存提示，不沿用旧结论。
  useEffect(() => {
    if (state !== 'editing') return
    const tested = lastTestedFingerprint.current
    const saved = lastSavedSummary.current
    if (
      (tested === null || tested === fingerprint) &&
      (saved === null || saved === savedSummaryFingerprint)
    ) {
      return
    }
    lastTestedFingerprint.current = null
    lastSavedSummary.current = null
    if (lastTestOutcome.current === 'success') toast.dismiss(TEST_TOAST_ID)
    lastTestOutcome.current = null
    onConnectionChanged?.()
  }, [state, fingerprint, savedSummaryFingerprint, onConnectionChanged])

  function applySavedSummary(saved: ConnectionSettingsVO): void {
    setProviderId(saved.providerId)
    setBaseUrl(saved.baseUrl)
    setModel(saved.model)
    setContextWindow(String(saved.contextWindow))
    setMaxOutputTokens(String(saved.maxOutputTokens))
    setTemperature(saved.temperature === undefined ? '' : String(saved.temperature))
    setTopP(saved.topP === undefined ? '' : String(saved.topP))
    setHasApiKey(saved.hasApiKey)
    dispatchExtension({ type: 'summary-loaded', hasExtension: saved.hasExtension })
  }

  async function load(mode: 'dialog' | 'section'): Promise<void> {
    const version = ++loadVersion.current
    dismissActionToasts()
    setLoadError(null)
    setApiKey('')
    dispatchExtension({ type: 'summary-loaded', hasExtension: false })
    setState('loading')
    const summary = await client.getSettingsSummary()
    if (version !== loadVersion.current) return
    if (summary.code !== 2000) {
      const description = '无法读取保存的连接设置；请检查文件是否损坏或被占用后重新读取。'
      if (mode === 'dialog') {
        setState('closed')
        toast.error('无法读取连接设置', {
          id: LOAD_FAILURE_TOAST_ID,
          description,
          duration: 12000,
          action: { label: '重新加载', onClick: () => void open() }
        })
        return
      }
      setLoadError(description)
      setState('editing')
      return
    }
    if (summary.data) {
      lastSummary.current = summary.data
      applySavedSummary(summary.data)
      setSummarySource('saved')
      setBaselineSummaryFingerprint(
        JSON.stringify([
          summary.data.providerId,
          summary.data.baseUrl,
          summary.data.model,
          String(summary.data.contextWindow),
          String(summary.data.maxOutputTokens),
          summary.data.temperature === undefined ? '' : String(summary.data.temperature),
          summary.data.topP === undefined ? '' : String(summary.data.topP),
          summary.data.hasExtension
        ])
      )
      setState('editing')
      return
    }
    if (lastSummary.current) {
      applySavedSummary(lastSummary.current)
      setSummarySource('session')
      setBaselineSummaryFingerprint(null)
      setState('editing')
      return
    }
    setProviderId('openai-compatible')
    setBaseUrl('')
    setModel('')
    setContextWindow(DEFAULT_CONTEXT_WINDOW)
    setMaxOutputTokens(DEFAULT_MAX_OUTPUT_TOKENS)
    setTemperature('')
    setTopP('')
    setHasApiKey(false)
    setSummarySource('empty')
    setBaselineSummaryFingerprint(
      JSON.stringify([
        'openai-compatible',
        '',
        '',
        DEFAULT_CONTEXT_WINDOW,
        DEFAULT_MAX_OUTPUT_TOKENS,
        '',
        '',
        false
      ])
    )
    setState('editing')
  }

  async function open(): Promise<void> {
    await load('dialog')
  }

  async function loadForSection(): Promise<void> {
    await load('section')
  }

  function discardChanges(): void {
    setApiKey('')
    setModels([])
    setListedFingerprint(null)
    if (lastSummary.current) {
      applySavedSummary(lastSummary.current)
      setSummarySource('saved')
      return
    }
    setProviderId('openai-compatible')
    setBaseUrl('')
    setModel('')
    setContextWindow(DEFAULT_CONTEXT_WINDOW)
    setMaxOutputTokens(DEFAULT_MAX_OUTPUT_TOKENS)
    setTemperature('')
    setTopP('')
    setHasApiKey(false)
    dispatchExtension({ type: 'closed' })
    setSummarySource('empty')
  }

  function close(): void {
    loadVersion.current += 1
    testVersion.current += 1
    setState('closed')
    setLoadError(null)
    dismissFlowToasts()
    setApiKey('')
    setModels([])
    setListedFingerprint(null)
    dispatchExtension({ type: 'closed' })
  }

  function draftFields(): ConnectionDraftFields {
    return { providerId, baseUrl, model, contextWindow, maxOutputTokens, temperature, topP, apiKey }
  }

  function buildRequest(): ConnectionSettingsDTO {
    return buildConnectionSettingsRequest(draftFields(), connectionExtensionRequest(extension))
  }

  async function testConnection(): Promise<void> {
    const version = ++testVersion.current
    const testedFingerprint = fingerprint
    dismissActionToasts()
    setState('testing')
    const result = await client.testConnection(buildRequest())
    setState('editing')
    const currentAttempt = version === testVersion.current
    const currentDraft = testedFingerprint === latestFingerprint.current
    if (currentAttempt && currentDraft) {
      lastTestedFingerprint.current = testedFingerprint
    }
    const outcome = result.code === 2000 ? 'confirmed' : 'failed'
    const confirmedFingerprint = connectionActionFingerprint(outcome, testedFingerprint)
    if (outcome === 'confirmed') {
      if (currentDraft) {
        lastTestOutcome.current = 'success'
        toast.success('测试通过', {
          id: TEST_TOAST_ID,
          description: '测试通过不会自动保存。',
          duration: 5000
        })
      }
      if (confirmedFingerprint !== null && currentAttempt && currentDraft) {
        callbacks.onConnectionTested?.(confirmedFingerprint)
      }
      return
    }
    lastTestOutcome.current = 'failure'
    toast.error('连接测试未通过', {
      id: TEST_TOAST_ID,
      description: failureToastDescription(result.msg, result.code, result.reason),
      duration: 12000,
      action: { label: '重新测试', onClick: () => void testConnection() }
    })
    if (currentAttempt && currentDraft) {
      callbacks.onConnectionTestFailed?.(testedFingerprint)
    }
  }

  async function saveSettings(): Promise<boolean> {
    dismissActionToasts()
    setState('saving')
    const request = buildRequest()
    const savedFingerprint = fingerprint
    const result = await client.saveSettings(request)
    setState('editing')
    const outcome = result.code === 2000 ? 'confirmed' : 'failed'
    const confirmedFingerprint = connectionActionFingerprint(outcome, savedFingerprint)
    if (outcome === 'confirmed') {
      const savedHasExtension =
        request.extension?.kind === 'set'
          ? true
          : request.extension?.kind === 'clear'
            ? false
            : extension.hasExtension
      setHasApiKey(result.data?.hasApiKey ?? hasApiKey)
      dispatchExtension({
        type: 'save-finished',
        hasExtension: result.data?.hasExtension ?? savedHasExtension
      })
      if (result.data) {
        lastSummary.current = result.data
        setSummarySource('saved')
        const nextBaseline = JSON.stringify([
          result.data.providerId,
          result.data.baseUrl,
          result.data.model,
          String(result.data.contextWindow),
          String(result.data.maxOutputTokens),
          result.data.temperature === undefined ? '' : String(result.data.temperature),
          result.data.topP === undefined ? '' : String(result.data.topP),
          result.data.hasExtension
        ])
        lastSavedSummary.current = nextBaseline
        setBaselineSummaryFingerprint(nextBaseline)
      }
      // 密钥清空会改变本地草稿指纹；保存成功后不再把这次改动当作“测试失效”。
      lastTestedFingerprint.current = null
      lastTestOutcome.current = null
      setApiKey('')
      toast.success('设置已保存', {
        id: SAVE_SUCCESS_TOAST_ID,
        description: '密钥不会回显；扩展内容保持隐藏。',
        duration: 4000
      })
      if (confirmedFingerprint !== null) {
        callbacks.onConnectionSaved?.(confirmedFingerprint)
      }
      return true
    }
    dispatchExtension({ type: 'save-finished' })
    toast.error('保存失败', {
      id: SAVE_FAILURE_TOAST_ID,
      description: failureToastDescription(result.msg, result.code, result.reason),
      duration: 12000,
      action: { label: '重试保存', onClick: () => void saveSettings() }
    })
    return false
  }

  async function listModels(): Promise<void> {
    dismissActionToasts()
    setState('listing')
    const result = await client.listModels(
      buildListModelsRequest({ providerId, baseUrl, apiKey }, connectionExtensionRequest(extension))
    )
    setState('editing')
    if (result.code === 2000 && result.data) {
      setModels(result.data.models)
      setListedFingerprint(accessFingerprint)
      toast.success(`已拉取 ${result.data.models.length} 个模型`, {
        id: LIST_TOAST_ID,
        duration: 4000
      })
      return
    }
    setModels([])
    setListedFingerprint(null)
    toast.error('无法拉取模型列表', {
      id: LIST_TOAST_ID,
      description: failureToastDescription(result.msg, result.code, result.reason),
      duration: 12000,
      action: { label: '重新拉取', onClick: () => void listModels() }
    })
  }

  const dirty =
    loadError === null &&
    state !== 'loading' &&
    state !== 'closed' &&
    (apiKey !== '' ||
      extension.mode === 'set' ||
      extension.mode === 'clear' ||
      (baselineSummaryFingerprint !== null &&
        savedSummaryFingerprint !== baselineSummaryFingerprint))

  return {
    state,
    loadError,
    dirty,
    providerId,
    baseUrl,
    model,
    apiKey,
    contextWindow,
    maxOutputTokens,
    temperature,
    topP,
    hasApiKey,
    hasExtension: extension.hasExtension,
    extensionDraft: extension.draft,
    extensionEditorOpen: extension.editorOpen,
    extensionMode: extension.mode,
    extensionClearConfirming: extension.confirmingClear,
    models: listedFingerprint === accessFingerprint ? models : [],
    summarySource,
    setProviderId,
    setBaseUrl,
    setModel,
    setApiKey,
    setContextWindow,
    setMaxOutputTokens,
    setTemperature,
    setTopP,
    setExtensionDraft: (value: string) => dispatchExtension({ type: 'draft-changed', value }),
    openExtensionEditor: () => dispatchExtension({ type: 'editor-opened' }),
    closeExtensionEditor: () => dispatchExtension({ type: 'editor-closed' }),
    requestExtensionClear: () => dispatchExtension({ type: 'clear-requested' }),
    cancelExtensionClear: () => dispatchExtension({ type: 'clear-cancelled' }),
    confirmExtensionClear: () => dispatchExtension({ type: 'clear-confirmed' }),
    undoExtensionClear: () => dispatchExtension({ type: 'clear-undone' }),
    open,
    loadForSection,
    close,
    discardChanges,
    testConnection,
    saveSettings,
    listModels
  }
}
