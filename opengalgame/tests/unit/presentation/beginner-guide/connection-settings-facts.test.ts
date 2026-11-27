// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO
} from '@application/settings/connections/vo/ConnectionSettingsVO'
import type { ConnectionSettingsClient } from '@interfaces/settings/connections/client/ConnectionSettingsClient'
import {
  useConnectionSettings,
  type ConnectionSettingsCallbacks,
  type SettingsFlow
} from '@presentation/features/connection-settings/useConnectionSettings'

// React 19 的 act 需要测试显式声明环境，否则只告警而不按测试语义收口更新。
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn()
  })
  return { toast }
})

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function fail(msg: string): AjaxResult<never> {
  return { code: 5000, msg }
}

function savedSettings(): ConnectionSettingsVO {
  return {
    providerId: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model-b',
    contextWindow: 128000,
    maxOutputTokens: 32768,
    hasApiKey: true,
    hasExtension: false
  }
}

function Probe({
  client,
  callbacks,
  expose
}: {
  client: ConnectionSettingsClient
  callbacks: ConnectionSettingsCallbacks
  expose: (flow: SettingsFlow) => void
}): ReactElement | null {
  expose(useConnectionSettings(client, callbacks))
  return null
}

function deferredTestClient(): {
  client: ConnectionSettingsClient
  resolveNext: (result: AjaxResult<ConnectionTestVO>) => void
  pendingCount: () => number
} {
  const pending: Array<(result: AjaxResult<ConnectionTestVO>) => void> = []
  const client = {
    getSettingsSummary: vi.fn(async () => ok(null)),
    testConnection: vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<AjaxResult<ConnectionTestVO>>()
      pending.push(resolve)
      return promise
    }),
    saveSettings: vi.fn(async () => ok(savedSettings())),
    listModels: vi.fn(async () => ok({ models: [] }))
  } as unknown as ConnectionSettingsClient
  return {
    client,
    resolveNext: (result) => {
      const resolve = pending.shift()
      if (!resolve) throw new Error('没有等待中的连接测试请求')
      resolve(result)
    },
    pendingCount: () => pending.length
  }
}

async function mountFlow(
  client: ConnectionSettingsClient,
  callbacks: ConnectionSettingsCallbacks
): Promise<{ flow: () => SettingsFlow; unmount: () => Promise<void> }> {
  const flowRef: { current: SettingsFlow | null } = { current: null }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(Probe, {
        client,
        callbacks,
        expose: (flow: SettingsFlow) => {
          flowRef.current = flow
        }
      })
    )
  })
  return {
    flow: () => {
      const flow = flowRef.current
      if (!flow) throw new Error('连接设置流程未挂载')
      return flow
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    }
  }
}

afterEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('连接设置结果拥有方的新手指引事实', () => {
  it('测试失败、配置改动、重测成功与保存回执按本次草稿发出', async () => {
    let testResult: AjaxResult<ConnectionTestVO> = fail('未通过')
    let saveResult: AjaxResult<ConnectionSettingsVO> = ok(savedSettings())
    const client = {
      getSettingsSummary: vi.fn(async () => ok(null)),
      testConnection: vi.fn(async () => testResult),
      saveSettings: vi.fn(async () => saveResult),
      listModels: vi.fn(async () => ok({ models: [] }))
    } as unknown as ConnectionSettingsClient
    const onConnectionChanged = vi.fn()
    const callbacks: ConnectionSettingsCallbacks = {
      onConnectionTested: vi.fn(),
      onConnectionTestFailed: vi.fn(),
      onConnectionChanged,
      onConnectionSaved: vi.fn()
    }
    const flowRef: { current: SettingsFlow | null } = { current: null }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(Probe, {
          client,
          callbacks,
          expose: (flow: SettingsFlow) => {
            flowRef.current = flow
          }
        })
      )
    })

    await act(async () => {
      flowRef.current?.setBaseUrl('https://example.test/v1')
      flowRef.current?.setModel('model-a')
      flowRef.current?.setApiKey('key-a')
    })

    await act(async () => {
      await flowRef.current?.testConnection()
    })
    expect(callbacks.onConnectionTestFailed).toHaveBeenCalledTimes(1)
    expect(callbacks.onConnectionTestFailed).toHaveBeenCalledWith(expect.any(String))
    expect(callbacks.onConnectionTested).not.toHaveBeenCalled()

    const changedBeforeSave = onConnectionChanged.mock.calls.length
    await act(async () => {
      flowRef.current?.setModel('model-b')
    })
    expect(onConnectionChanged).toHaveBeenCalledTimes(changedBeforeSave + 1)

    testResult = ok({ available: true })
    await act(async () => {
      await flowRef.current?.testConnection()
    })
    expect(callbacks.onConnectionTested).toHaveBeenCalledTimes(1)

    await act(async () => {
      const saved = await flowRef.current?.saveSettings()
      expect(saved).toBe(true)
    })
    expect(callbacks.onConnectionSaved).toHaveBeenCalledTimes(1)
    // 保存成功会清空本地密钥；这次指纹变化不能再误报配置改动。
    expect(onConnectionChanged).toHaveBeenCalledTimes(changedBeforeSave + 1)

    await act(async () => {
      root.unmount()
    })
  })

  it('被新请求取代的旧响应仍更新页面，只过滤教程事实', async () => {
    const { client, resolveNext, pendingCount } = deferredTestClient()
    const callbacks: ConnectionSettingsCallbacks = {
      onConnectionTested: vi.fn(),
      onConnectionTestFailed: vi.fn(),
      onConnectionChanged: vi.fn(),
      onConnectionSaved: vi.fn()
    }
    const harness = await mountFlow(client, callbacks)
    await act(async () => {
      harness.flow().setBaseUrl('https://example.test/v1')
      harness.flow().setModel('model-a')
      harness.flow().setApiKey('key-a')
    })

    await act(async () => {
      void harness.flow().testConnection()
    })
    expect(harness.flow().state).toBe('testing')
    await act(async () => {
      void harness.flow().testConnection()
    })
    expect(pendingCount()).toBe(2)

    await act(async () => {
      resolveNext(ok({ available: true }))
    })
    expect(harness.flow().state).toBe('editing')
    expect(toast.success).toHaveBeenCalledWith(
      '测试通过',
      expect.objectContaining({
        id: 'connection-test-result',
        description: '测试通过不会自动保存。'
      })
    )
    expect(callbacks.onConnectionTested).not.toHaveBeenCalled()

    await act(async () => {
      resolveNext(fail('本次未通过'))
    })
    expect(harness.flow().state).toBe('editing')
    expect(toast.error).toHaveBeenCalledWith(
      '连接测试未通过',
      expect.objectContaining({
        id: 'connection-test-result',
        description: expect.stringContaining('本次未通过（未分类的连接错误）')
      })
    )
    expect(callbacks.onConnectionTestFailed).toHaveBeenCalledTimes(1)
    expect(callbacks.onConnectionTested).not.toHaveBeenCalled()
    await harness.unmount()
  })

  it('测试期间改动草稿的迟到失败只过滤教程事实，页面回执保留', async () => {
    const { client, resolveNext, pendingCount } = deferredTestClient()
    const callbacks: ConnectionSettingsCallbacks = {
      onConnectionTested: vi.fn(),
      onConnectionTestFailed: vi.fn(),
      onConnectionChanged: vi.fn(),
      onConnectionSaved: vi.fn()
    }
    const harness = await mountFlow(client, callbacks)
    await act(async () => {
      harness.flow().setBaseUrl('https://example.test/v1')
      harness.flow().setModel('model-a')
      harness.flow().setApiKey('key-a')
    })

    await act(async () => {
      void harness.flow().testConnection()
    })
    expect(pendingCount()).toBe(1)
    await act(async () => {
      harness.flow().setModel('model-b')
    })
    expect(harness.flow().state).toBe('testing')

    await act(async () => {
      resolveNext(fail('草稿已改'))
    })
    expect(harness.flow().state).toBe('editing')
    expect(toast.error).toHaveBeenCalledWith(
      '连接测试未通过',
      expect.objectContaining({
        description: expect.stringContaining('草稿已改（未分类的连接错误）')
      })
    )
    expect(callbacks.onConnectionTestFailed).not.toHaveBeenCalled()

    // 迟到结果不算当前草稿的测试结论，后续改动也不应误报失效。
    await act(async () => {
      harness.flow().setModel('model-c')
    })
    expect(callbacks.onConnectionChanged).not.toHaveBeenCalled()

    await act(async () => {
      void harness.flow().testConnection()
    })
    await act(async () => {
      resolveNext(ok({ available: true }))
    })
    expect(toast.success).toHaveBeenCalledWith('测试通过', expect.anything())
    expect(callbacks.onConnectionTested).toHaveBeenCalledTimes(1)
    await harness.unmount()
  })

  it('失败回执经全局通知携带安全分类，关闭和重开后旧结果不再出现，新失败重新出现', async () => {
    const client = {
      getSettingsSummary: vi.fn(async () => ok(null)),
      testConnection: vi.fn(async () => ({
        code: 1407,
        msg: '模型服务未返回有效结果',
        reason: 'providerHttpStatus400'
      })),
      saveSettings: vi.fn(async () => ok(savedSettings())),
      listModels: vi.fn()
    } as unknown as ConnectionSettingsClient
    const harness = await mountFlow(client, {})
    await act(async () => {
      await harness.flow().open()
    })
    await act(async () => {
      await harness.flow().testConnection()
    })
    expect(toast.error).toHaveBeenCalledWith(
      '连接测试未通过',
      expect.objectContaining({
        id: 'connection-test-result',
        description: expect.stringContaining('模型服务未返回有效结果（上游拒绝了测试请求）')
      })
    )
    expect(toast.error).toHaveBeenCalledWith(
      '连接测试未通过',
      expect.objectContaining({
        description: expect.stringContaining(
          '按供应商要求检查扩展 JSON 的 defaultHeaders、模型和请求参数。'
        )
      })
    )

    await act(async () => {
      harness.flow().close()
    })
    expect(toast.dismiss).toHaveBeenCalledWith('connection-test-result')

    await act(async () => {
      await harness.flow().open()
    })
    await act(async () => {
      await harness.flow().testConnection()
    })
    expect(toast.error).toHaveBeenCalledTimes(2)
    await harness.unmount()
  })

  it('保存本身不算改动；保存后再改可见配置才发失效事实', async () => {
    const client = {
      getSettingsSummary: vi.fn(async () => ok(savedSettings())),
      testConnection: vi.fn(),
      saveSettings: vi.fn(async () => ok(savedSettings())),
      listModels: vi.fn()
    } as unknown as ConnectionSettingsClient
    const onConnectionChanged = vi.fn()
    const harness = await mountFlow(client, { onConnectionChanged })
    await act(async () => {
      await harness.flow().open()
    })
    await act(async () => {
      await harness.flow().saveSettings()
    })
    expect(onConnectionChanged).not.toHaveBeenCalled()

    await act(async () => {
      harness.flow().setBaseUrl('https://example.test/v2')
    })
    expect(onConnectionChanged).toHaveBeenCalledTimes(1)
    await harness.unmount()
  })
})
