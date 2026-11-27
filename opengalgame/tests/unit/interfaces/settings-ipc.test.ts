import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SaveAppearanceSettingsDTO } from '@application/settings/appearance/dto/AppearanceSettingsDTO'
import type { AppearanceSettingsGateway } from '@application/settings/appearance/ports/AppearanceSettingsGateway'
import { ManageAppearanceSettings } from '@application/settings/appearance/services/impl/ManageAppearanceSettings'
import type { AppearanceSettingsVO } from '@application/settings/appearance/vo/AppearanceSettingsVO'
import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AppearanceSettings } from '@domain/settings/appearance/models/AppearanceSettings'
import type { ProjectController } from '@interfaces/ipc/controllers/ProjectController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { registerHomeIpc } from '@interfaces/ipc/registerHomeIpc'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'
import { AppearanceSettingsClientImpl } from '@interfaces/settings/appearance/client/AppearanceSettingsClientImpl'
import { AppearanceSettingsController } from '@interfaces/settings/appearance/ipc/AppearanceSettingsController'
import { ConnectionSettingsController } from '@interfaces/settings/connections/ipc/ConnectionSettingsController'
import { registerSettingsIpc } from '@interfaces/settings/ipc/registerSettingsIpc'

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
const access = { trusted: true, requestId: 'r' }

const validRequest: SaveAppearanceSettingsDTO = {
  fontPresetId: 'source-han-sans',
  bodyTextSize: 16,
  glassOpacity: 75,
  highContrast: true,
  reducedMotion: 'off',
  themePreset: 'default'
}

const defaultVO = {
  fontPresetId: 'system',
  bodyTextSize: 15,
  glassOpacity: 70,
  highContrast: false,
  reducedMotion: 'system',
  themePreset: 'default'
} as const

function loggerOf() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function appearanceFixture() {
  const gateway = {
    read: vi.fn(async (): Promise<AppearanceSettings | null> => null),
    save: vi.fn<(settings: AppearanceSettings) => Promise<void>>(async () => undefined)
  } satisfies AppearanceSettingsGateway
  const logger = loggerOf()
  const controller = new AppearanceSettingsController(
    new ManageAppearanceSettings({ settings: gateway, logger }),
    new IpcExceptionHandler(logger, new IpcErrorMapper())
  )
  return { controller, gateway, logger }
}

interface WindowFixture {
  window: { isDestroyed: () => boolean; webContents: unknown }
  frame: { url: string }
  webContents: { isDestroyed: () => boolean; mainFrame: { url: string } }
}

function windowFixture(): WindowFixture {
  const frame = { url: rendererUrl }
  const webContents = { isDestroyed: () => false, mainFrame: frame }
  return { window: { isDestroyed: () => false, webContents }, frame, webContents }
}

function installBrowserGlobals(search: string): void {
  vi.stubGlobal('window', { location: { search } })
  vi.stubGlobal('document', {
    createElement: () => ({ setAttribute: () => undefined, hidden: false }),
    body: { append: () => undefined }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  ipc.handlers.clear()
})

describe('外观设置控制器', () => {
  it('读取无入参返回完整默认值和字体目录，不写盘也不告警', async () => {
    const { controller, gateway, logger } = appearanceFixture()

    expect(await controller.readAppearance({}, access)).toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    expect(
      await controller.readAppearance(undefined, { trusted: false, requestId: 'r' })
    ).toMatchObject({ code: ErrorCodes.forbidden })

    const result = await controller.readAppearance(undefined, access)
    expect(result).toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已读取',
      data: defaultVO
    })
    expect(result.data?.fontPresets).toHaveLength(12)
    expect(result.data?.fontPresets[0]).toEqual({
      id: 'system',
      label: '系统字体',
      family: 'system-ui',
      fallback: expect.any(String),
      bundled: false,
      roles: ['body', 'dialogue', 'title']
    })
    expect(gateway.read).toHaveBeenCalledTimes(1)
    expect(gateway.save).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('保存拒绝缺字段、多余字段和非三态动效，均在写入前返回 4101', async () => {
    const { controller, gateway } = appearanceFixture()
    const missingHighContrast = { ...validRequest }
    delete (missingHighContrast as Partial<SaveAppearanceSettingsDTO>).highContrast

    for (const input of [
      { ...validRequest, extra: true },
      missingHighContrast,
      { ...validRequest, reducedMotion: 'auto' },
      { ...validRequest, bodyTextSize: '16' }
    ]) {
      expect(await controller.saveAppearance(input, access)).toMatchObject({
        code: ErrorCodes.invalidRequest
      })
    }
    expect(gateway.save).not.toHaveBeenCalled()
  })

  it('形状合法但领域越界时返回 1501，且不写入', async () => {
    const { controller, gateway } = appearanceFixture()

    for (const input of [
      { ...validRequest, bodyTextSize: 25 },
      { ...validRequest, glassOpacity: 72 },
      { ...validRequest, fontPresetId: 'unknown-font' },
      { ...validRequest, themePreset: 'dark' }
    ]) {
      expect(await controller.saveAppearance(input, access)).toMatchObject({ code: 1501 })
    }
    expect(gateway.save).not.toHaveBeenCalled()
  })

  it('保存一次写入完整六项，并直接返回同值 VO', async () => {
    const { controller, gateway } = appearanceFixture()

    const result = await controller.saveAppearance(validRequest, access)
    expect(result).toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已保存',
      data: validRequest
    })
    expect(result.data?.fontPresets).toHaveLength(12)
    expect(gateway.save).toHaveBeenCalledTimes(1)
    expect(gateway.save).toHaveBeenCalledWith(validRequest)
  })
})

describe('外观客户端与 preload 通道', () => {
  const vo: AppearanceSettingsVO = { ...defaultVO, fontPresets: [] }

  it('读取不传第二参数，保存映射六项请求，传输异常返回 5102', async () => {
    const invoke = vi.fn(async () => ({
      code: ErrorCodes.success,
      msg: '外观设置已读取',
      data: vo
    }))
    const bridge = createDesktopBridge({ invoke, subscribe: vi.fn(() => vi.fn()) })
    const client = new AppearanceSettingsClientImpl(bridge)

    expect(await client.readAppearance()).toEqual({
      code: ErrorCodes.success,
      msg: '外观设置已读取',
      data: vo
    })
    expect(invoke.mock.calls[0]).toEqual(['settings:read-appearance'])

    invoke.mockResolvedValueOnce({ code: ErrorCodes.success, msg: '外观设置已保存', data: vo })
    expect(await client.saveAppearance(validRequest)).toEqual({
      code: ErrorCodes.success,
      msg: '外观设置已保存',
      data: vo
    })
    expect(invoke).toHaveBeenLastCalledWith('settings:save-appearance', validRequest)

    invoke.mockRejectedValueOnce(new Error('C:/secret/appearance.json'))
    const offline = await client.saveAppearance(validRequest)
    expect(offline).toEqual({
      code: ErrorCodes.communicationFailed,
      msg: '与主进程通信失败，操作结果待确认'
    })
    expect(offline.msg).not.toContain('C:/secret')
  })
})

describe('设置 IPC 注册器', () => {
  function connectionController(): ConnectionSettingsController {
    return new ConnectionSettingsController(
      {
        getSettingsSummary: vi.fn(async () => null),
        testConnection: vi.fn(async () => ({ available: true })),
        saveSettings: vi.fn(async () => null),
        listModels: vi.fn(async () => ({ models: [] }))
      } as never,
      new IpcExceptionHandler(loggerOf(), new IpcErrorMapper())
    )
  }

  it('连接只在设置注册器注册，外观两条通道与清理不影响首页通道', async () => {
    const { window, frame, webContents } = windowFixture()
    const binding = { getWindow: () => window as never, rendererUrl }

    const detachHome = registerHomeIpc({
      ...binding,
      projects: {} as ProjectController
    })
    expect(ipc.handlers.size).toBe(10)
    expect([...ipc.handlers.keys()].filter((channel) => channel.startsWith('connection:'))).toEqual(
      []
    )

    const detachSettings = registerSettingsIpc({
      ...binding,
      connections: connectionController(),
      appearance: appearanceFixture().controller
    })
    expect(ipc.handlers.size).toBe(16)
    expect([...ipc.handlers.keys()].filter((channel) => channel.startsWith('connection:'))).toEqual([
      'connection:get-summary',
      'connection:test',
      'connection:save',
      'connection:list-models'
    ])

    const call = (
      channel: string,
      input: unknown,
      event: unknown = { sender: webContents, senderFrame: frame }
    ) => {
      const handler = ipc.handlers.get(channel)
      if (handler === undefined) throw new Error(`missing channel ${channel}`)
      return handler(event, input)
    }

    await expect(call('connection:get-summary', undefined)).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '操作成功',
      data: null
    })
    await expect(call('settings:read-appearance', undefined)).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已读取',
      data: defaultVO
    })
    await expect(call('settings:read-appearance', {})).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      call('settings:read-appearance', undefined, { sender: {}, senderFrame: frame })
    ).resolves.toMatchObject({ code: ErrorCodes.forbidden })
    await expect(
      call('settings:save-appearance', { ...validRequest, extra: true })
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(call('settings:save-appearance', validRequest)).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已保存',
      data: validRequest
    })

    detachSettings()
    expect(
      [...ipc.handlers.keys()].filter(
        (channel) => channel.startsWith('settings:') || channel.startsWith('connection:')
      )
    ).toEqual([])
    expect(ipc.handlers.size).toBe(10)
    detachHome()
    expect(ipc.handlers.size).toBe(0)
  })
})

describe('浏览器开发桥外观替身', () => {
  it('非文件模式默认读、坏 payload 与合法读写都走同一控制器契约', async () => {
    vi.stubEnv('VITE_OPENGALGAME_BROWSER_FILES', 'fixture')
    installBrowserGlobals('')
    const bridge = createBrowserDesktopBridge()

    await expect(bridge.readAppearance()).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已读取',
      data: defaultVO
    })

    await expect(
      bridge.saveAppearance({ ...validRequest, extra: true } as never)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      bridge.saveAppearance({ ...validRequest, glassOpacity: 72 } as never)
    ).resolves.toMatchObject({ code: 1501 })

    const saved = await bridge.saveAppearance(validRequest)
    expect(saved).toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已保存',
      data: validRequest
    })
    expect(saved.data?.fontPresets).toHaveLength(12)

    const reread = await bridge.readAppearance()
    expect(reread).toMatchObject({
      code: ErrorCodes.success,
      msg: '外观设置已读取',
      data: validRequest
    })
    expect(reread.data?.fontPresets).toHaveLength(12)
  })

  it('文件模式把无参数读取和六项保存转给同一开发后端', async () => {
    vi.stubEnv('VITE_OPENGALGAME_BROWSER_FILES', 'real')
    installBrowserGlobals('?workbench=filled')
    const vo: AppearanceSettingsVO = { ...defaultVO, fontPresets: [] }
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => ({ code: ErrorCodes.success, msg: '外观设置已读取', data: vo })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const bridge = createBrowserDesktopBridge()

    await bridge.readAppearance()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [readUrl, readInit] = fetchMock.mock.calls[0]!
    expect(readUrl).toBe('/__opengalgame/dev/call')
    expect(readInit.body).toBe(JSON.stringify({ method: 'readAppearance' }))

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: ErrorCodes.success, msg: '外观设置已保存', data: vo })
    })
    await bridge.saveAppearance(validRequest)
    const [, saveInit] = fetchMock.mock.calls[1]!
    expect(JSON.parse(saveInit.body)).toEqual({
      method: 'saveAppearance',
      input: validRequest
    })

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: ErrorCodes.invalidRequest, msg: '请求参数格式不正确' })
    })
    await expect(
      bridge.saveAppearance({ ...validRequest, extra: true } as never)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    const [, rejectedInit] = fetchMock.mock.calls[2]!
    expect(JSON.parse(rejectedInit.body).input).toMatchObject({ extra: true })
  })
})

