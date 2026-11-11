import { useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ConnectionSettingsDTO } from '@application/connections/dto/ConnectionSettingsDTO'
import type { ConnectionSettingsVO } from '@application/connections/vo/ConnectionSettingsVO'
import type { ConnectionSettingsClient } from '@interfaces/client/ConnectionSettingsClient'
import {
  buildConnectionSettingsRequest,
  buildListModelsRequest,
  connectionExtensionFingerprint,
  connectionExtensionReducer,
  connectionExtensionRequest,
  emptyConnectionExtensionDraft,
  type ConnectionDraftFields,
  type ConnectionExtensionMode
} from './connectionDraft'

/**
 * 从未保存过连接配置时的草稿默认值；已保存配置始终以磁盘摘要为准，不用这里覆盖。
 * 最大输出不再取 4096：现场生成会在 4096 处截断，默认值与上下文窗口保持同一量级。
 */
const DEFAULT_CONTEXT_WINDOW = '128000'
const DEFAULT_MAX_OUTPUT_TOKENS = '32768'

export type SettingsViewState =
  'closed' | 'loading' | 'load-error' | 'editing' | 'testing' | 'saving' | 'listing'

/** 已保存摘要来自磁盘、本次会话缓存，或还没有保存过。 */
export type SettingsSummarySource = 'saved' | 'session' | 'empty'

type SettingsFeedback = {
  kind: 'success' | 'error'
  title: string
  detail: string
} & ({ source: 'test'; fingerprint: string } | { source: 'save' | 'list' | 'load' })

export interface SettingsFlow {
  state: SettingsViewState
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
  status: { kind: 'success' | 'error'; title: string; detail: string } | null
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
  close: () => void
  testConnection: () => Promise<void>
  saveSettings: () => Promise<boolean>
  listModels: () => Promise<void>
}

export function useConnectionSettings(client: ConnectionSettingsClient): SettingsFlow {
  const [state, setState] = useState<SettingsViewState>('closed')
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
  const [status, setStatus] = useState<SettingsFeedback | null>(null)
  const [summarySource, setSummarySource] = useState<SettingsSummarySource>('empty')
  const [extension, dispatchExtension] = useReducer(
    connectionExtensionReducer,
    emptyConnectionExtensionDraft
  )
  const loadVersion = useRef(0)
  const lastSummary = useRef<ConnectionSettingsVO | null>(null)

  useEffect(
    () => () => {
      loadVersion.current += 1
    },
    []
  )

  const extensionFingerprint = connectionExtensionFingerprint(extension)
  const fingerprint = JSON.stringify([
    providerId,
    baseUrl,
    model,
    apiKey,
    contextWindow,
    maxOutputTokens,
    temperature,
    topP,
    extensionFingerprint
  ])
  const accessFingerprint = JSON.stringify([providerId, baseUrl, apiKey, extensionFingerprint])

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

  async function open(): Promise<void> {
    const version = ++loadVersion.current
    setApiKey('')
    dispatchExtension({ type: 'summary-loaded', hasExtension: false })
    setState('loading')
    const summary = await client.getSettingsSummary()
    if (version !== loadVersion.current) return
    if (summary.code !== 2000) {
      setState('load-error')
      setStatus({ source: 'load', kind: 'error', title: '无法读取连接设置', detail: summary.msg })
      return
    }
    if (summary.data) {
      lastSummary.current = summary.data
      applySavedSummary(summary.data)
      setSummarySource('saved')
      setState('editing')
      return
    }
    if (lastSummary.current) {
      applySavedSummary(lastSummary.current)
      setSummarySource('session')
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
    setState('editing')
  }

  function close(): void {
    loadVersion.current += 1
    setState('closed')
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

  /** 用当前草稿测试上游连接，结果只作反馈、不落盘。 */
  async function testConnection(): Promise<void> {
    setState('testing')
    const result = await client.testConnection(buildRequest())
    setState('editing')
    if (result.code === 2000) {
      const feedback = {
        source: 'test' as const,
        fingerprint,
        kind: 'success' as const,
        title: '测试通过',
        detail: '当前输入可用。测试通过不会自动保存。'
      }
      setStatus(feedback)
      toast.success(feedback.title, { description: feedback.detail })
      return
    }
    const failure = {
      source: 'test' as const,
      fingerprint,
      kind: 'error' as const,
      title: '连接测试未通过',
      detail: result.msg
    }
    setStatus(failure)
    toast.error(failure.title, { description: failure.detail })
  }

  /** 保存当前连接设置，成功后清空密钥与扩展草稿，并按返回摘要刷新状态。 */
  async function saveSettings(): Promise<boolean> {
    setState('saving')
    const request = buildRequest()
    const result = await client.saveSettings(request)
    setState('editing')
    if (result.code === 2000) {
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
      }
      setApiKey('')
      const feedback = {
        source: 'save' as const,
        kind: 'success' as const,
        title: '设置已保存',
        detail: '密钥和扩展配置不会出现在查询结果中。'
      }
      setStatus(feedback)
      toast.success(feedback.title, { description: feedback.detail })
      return true
    }
    dispatchExtension({ type: 'save-finished' })
    const failure = {
      source: 'save' as const,
      kind: 'error' as const,
      title: '保存失败',
      detail: result.msg
    }
    setStatus(failure)
    toast.error(failure.title, { description: failure.detail })
    return false
  }

  async function listModels(): Promise<void> {
    setState('listing')
    const result = await client.listModels(
      buildListModelsRequest({ providerId, baseUrl, apiKey }, connectionExtensionRequest(extension))
    )
    setState('editing')
    if (result.code === 2000 && result.data) {
      setModels(result.data.models)
      setListedFingerprint(accessFingerprint)
      const feedback = {
        source: 'list' as const,
        kind: 'success' as const,
        title: `已拉取 ${result.data.models.length} 个模型`,
        detail: '打开下拉即可填入模型名。'
      }
      setStatus(feedback)
      toast.success(feedback.title, { description: feedback.detail })
      return
    }
    setModels([])
    setListedFingerprint(null)
    const failure = {
      source: 'list' as const,
      kind: 'error' as const,
      title: '无法拉取模型列表',
      detail: result.msg
    }
    setStatus(failure)
    toast.error(failure.title, { description: failure.detail })
  }

  return {
    state,
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
    status:
      status?.source === 'test' && status.kind === 'success' && status.fingerprint !== fingerprint
        ? null
        : status,
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
    close,
    testConnection,
    saveSettings,
    listModels
  }
}
