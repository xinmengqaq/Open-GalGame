import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { AppUpdateApplicationService } from '@application/app-update/services/AppUpdateApplicationService'
import type { UpdateCheckVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { AppUpdateClientImpl } from '@interfaces/app-update/client/AppUpdateClientImpl'
import { AppUpdateController } from '@interfaces/app-update/ipc/AppUpdateController'
import { registerAppUpdateIpc } from '@interfaces/app-update/ipc/registerAppUpdateIpc'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      ipc.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipc.handlers.delete(channel)
    }
  },
  webUtils: { getPathForFile: () => '' }
}))

const rendererUrl = 'http://127.0.0.1:5173/'

function idleStatus(): UpdateStatusVO {
  return { phase: 'idle', currentVersion: '0.1.0', supported: true }
}

function downloadingStatus(): UpdateStatusVO {
  return {
    phase: 'downloading',
    currentVersion: '0.1.0',
    supported: true,
    release: { version: '0.1.1' },
    progress: { percent: 25, transferred: 250, total: 1000, bytesPerSecond: 100 }
  }
}

function loggerOf(): LoggerGateway {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
}

interface ServiceFixture {
  service: AppUpdateApplicationService
  calls: string[]
  listeners: Set<(status: UpdateStatusVO) => void>
}

function serviceFixture(): ServiceFixture {
  const calls: string[] = []
  const listeners = new Set<(status: UpdateStatusVO) => void>()
  const check: UpdateCheckVO = { phase: 'idle', currentVersion: '0.1.0' }
  const service: AppUpdateApplicationService = {
    checkForUpdate: vi.fn(async () => {
      calls.push('check')
      return check
    }),
    downloadUpdate: vi.fn(async () => {
      calls.push('download')
      return downloadingStatus()
    }),
    installUpdate: vi.fn(async () => {
      calls.push('install')
    }),
    readStatus: vi.fn(async () => {
      calls.push('read')
      return idleStatus()
    }),
    subscribe: vi.fn((listener: (status: UpdateStatusVO) => void) => {
      calls.push('subscribe')
      listeners.add(listener)
      return () => {
        calls.push('unsubscribe')
        listeners.delete(listener)
      }
    })
  }
  return { service, calls, listeners }
}

interface WebContentsFixture {
  isDestroyed: () => boolean
  send: Mock
  mainFrame: { url: string }
}

interface WindowFixture {
  isDestroyed: () => boolean
  webContents: WebContentsFixture
}

function windowFixture(): {
  window: WindowFixture
  frame: { url: string }
  webContents: WebContentsFixture
} {
  const frame = { url: rendererUrl }
  const webContents: WebContentsFixture = {
    isDestroyed: () => false,
    send: vi.fn(),
    mainFrame: frame
  }
  const window: WindowFixture = { isDestroyed: () => false, webContents }
  return { window, frame, webContents }
}

function register(service: AppUpdateApplicationService, window: unknown): () => void {
  return registerAppUpdateIpc({
    controller: new AppUpdateController(service, new IpcExceptionHandler(loggerOf())),
    subscribe: (listener) => service.subscribe(listener),
    getWindow: () => window as never,
    rendererUrl
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('应用更新 IPC 与客户端', () => {
  it('四个固定通道严格校验请求并保留受信任来源', async () => {
    const { service, calls } = serviceFixture()
    const { window, frame, webContents } = windowFixture()
    const detach = register(service, window)
    const event = { sender: webContents, senderFrame: frame }
    const call = (channel: string, input: unknown, source = event): Promise<unknown> => {
      const handler = ipc.handlers.get(channel)
      if (handler === undefined) throw new Error(`missing channel ${channel}`)
      return handler(source, input)
    }

    expect(ipc.handlers.size).toBe(4)
    await expect(call('app-update:check', { reason: 'manual' })).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '更新检查完成',
      data: { phase: 'idle', currentVersion: '0.1.0' }
    })
    await expect(call('app-update:check', { reason: 'background' })).resolves.toMatchObject({
      code: ErrorCodes.success
    })
    await expect(
      call('app-update:check', { reason: 'manual', url: 'https://evil.example/feed' })
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(call('app-update:check', { reason: 'auto' })).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(call('app-update:check', {})).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })

    await expect(call('app-update:download', {})).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '更新下载已开始',
      data: downloadingStatus()
    })
    await expect(call('app-update:download', { installArgs: ['/S'] })).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      call('app-update:download', { url: 'https://evil.example/update' })
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })

    await expect(call('app-update:install', {})).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '正在重启安装更新',
      data: null
    })
    await expect(
      call('app-update:install', { outputPath: 'D:/secret/install' })
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })

    await expect(call('app-update:read-status', {})).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '更新状态已读取',
      data: idleStatus()
    })
    await expect(call('app-update:read-status', { version: '9.9.9' })).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })

    const foreign = {
      sender: { isDestroyed: () => false, send: vi.fn() },
      senderFrame: { url: rendererUrl }
    }
    await expect(call('app-update:check', { reason: 'manual' }, foreign)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })

    expect(service.checkForUpdate).toHaveBeenCalledTimes(2)
    expect(service.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(service.installUpdate).toHaveBeenCalledTimes(1)
    expect(service.readStatus).toHaveBeenCalledTimes(1)

    detach()
    expect(ipc.handlers.size).toBe(0)
    expect(calls).toContain('unsubscribe')
  })

  it('状态推送只发往存活窗口，非法状态和额外字段被丢弃', () => {
    const { service, listeners } = serviceFixture()
    const { window, webContents } = windowFixture()
    const detach = register(service, window)
    const publish = (value: unknown): void => {
      for (const listener of [...listeners]) listener(value as UpdateStatusVO)
    }

    const valid = downloadingStatus()
    publish(valid)
    expect(webContents.send).toHaveBeenCalledWith('app-update:status', valid)

    publish({ ...idleStatus(), phase: 'exploded' })
    publish({
      ...idleStatus(),
      progress: { percent: 150, transferred: 1, total: 1, bytesPerSecond: 1 }
    })
    publish({ ...idleStatus(), releaseNotes: '<script>alert(1)</script>' })
    publish({ ...idleStatus(), url: 'https://evil.example/feed' })
    publish({ phase: 'failed', currentVersion: '0.1.0', supported: true })
    expect(webContents.send).toHaveBeenCalledTimes(1)

    window.isDestroyed = () => true
    publish(valid)
    expect(webContents.send).toHaveBeenCalledTimes(1)

    window.isDestroyed = () => false
    webContents.isDestroyed = () => true
    publish(valid)
    expect(webContents.send).toHaveBeenCalledTimes(1)

    detach()
    expect(listeners.size).toBe(0)
    expect(ipc.handlers.size).toBe(0)
  })

  it('客户端解析四个通道并丢弃非法响应与非法推送', async () => {
    let subscribed: { channel: string; listener: (value: unknown) => void } | undefined
    const unsubscribe = vi.fn()
    const bridge = createDesktopBridge({
      invoke: async (channel) => {
        if (channel === 'app-update:check')
          return {
            code: 2000,
            msg: '更新检查完成',
            data: { phase: 'idle', currentVersion: '0.1.0' }
          }
        if (channel === 'app-update:download')
          return { code: 2000, msg: '更新下载已开始', data: downloadingStatus() }
        if (channel === 'app-update:install')
          return { code: 2000, msg: '正在重启安装更新', data: null }
        if (channel === 'app-update:read-status')
          return { code: 2000, msg: '更新状态已读取', data: idleStatus() }
        return { code: 5102, msg: '错误通道' }
      },
      subscribe: (channel, listener) => {
        subscribed = { channel, listener }
        return unsubscribe
      }
    })
    const client = new AppUpdateClientImpl(bridge)

    await expect(client.checkForUpdate({ reason: 'manual' })).resolves.toEqual({
      code: 2000,
      msg: '更新检查完成',
      data: { phase: 'idle', currentVersion: '0.1.0' }
    })
    await expect(client.downloadUpdate({})).resolves.toEqual({
      code: 2000,
      msg: '更新下载已开始',
      data: downloadingStatus()
    })
    await expect(client.installUpdate({})).resolves.toEqual({
      code: 2000,
      msg: '正在重启安装更新',
      data: null
    })
    await expect(client.readUpdateStatus({})).resolves.toEqual({
      code: 2000,
      msg: '更新状态已读取',
      data: idleStatus()
    })

    const received: UpdateStatusVO[] = []
    const off = client.onStatus((status) => received.push(status))
    expect(subscribed?.channel).toBe('app-update:status')
    subscribed?.listener(idleStatus())
    subscribed?.listener({ phase: 'idle', currentVersion: '0.1.0', supported: true, extra: true })
    subscribed?.listener({ ...idleStatus(), phase: 'unknown' })
    expect(received).toEqual([idleStatus()])
    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('客户端把结构不符的成功响应收成通信失败', async () => {
    const bridge = createDesktopBridge({
      invoke: async (channel) => {
        if (channel === 'app-update:check')
          return {
            code: 2000,
            msg: '更新检查完成',
            data: { phase: 'available', currentVersion: '0.1.0' }
          }
        if (channel === 'app-update:install') return { code: 2000, msg: '正在重启安装更新' }
        return { code: 2000, msg: '更新状态已读取', data: idleStatus() }
      },
      subscribe: () => () => undefined
    })
    const client = new AppUpdateClientImpl(bridge)
    await expect(client.checkForUpdate({ reason: 'manual' })).resolves.toMatchObject({
      code: 5102
    })
    await expect(client.installUpdate({})).resolves.toMatchObject({ code: 5102 })
  })

  it('缺少推送能力时退订为空操作，读取仍执行', async () => {
    const bridge = {
      readUpdateStatus: async () => ({
        code: 2000,
        msg: '更新状态已读取',
        data: idleStatus()
      })
    } as unknown as DesktopBridge
    const client = new AppUpdateClientImpl(bridge)

    const off = client.onStatus(() => {
      throw new Error('没有推送能力时不应触发')
    })
    expect(off()).toBeUndefined()
    await expect(client.readUpdateStatus({})).resolves.toMatchObject({
      code: 2000,
      data: idleStatus()
    })
  })

  it('浏览器桥固定报告不支持，读取返回开发版本的空闲状态', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })
    const browser = createBrowserDesktopBridge()

    await expect(browser.checkForUpdate({ reason: 'manual' })).resolves.toEqual({
      code: ErrorCodes.invalidConfig,
      msg: '当前运行形态不支持应用内更新'
    })
    await expect(browser.downloadUpdate({})).resolves.toMatchObject({
      code: ErrorCodes.invalidConfig
    })
    await expect(browser.installUpdate({})).resolves.toMatchObject({
      code: ErrorCodes.invalidConfig
    })
    const status = await browser.readUpdateStatus({})
    expect(status).toMatchObject({
      code: ErrorCodes.success,
      data: { phase: 'idle', supported: false }
    })
    expect(status.data?.currentVersion).toMatch(/^\d+\.\d+\.\d+$/u)
    const off = browser.onAppUpdateStatus(() => {
      throw new Error('浏览器桥不应推送更新状态')
    })
    expect(off()).toBeUndefined()
  })
})
