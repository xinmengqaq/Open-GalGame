import { describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { ProjectClientImpl } from '@interfaces/client/ProjectClientImpl'
import { desktopBridgeChannels } from '@interfaces/contracts/desktopBridgeChannels'
import { ConnectionSettingsController } from '@interfaces/ipc/controllers/ConnectionSettingsController'
import { ProjectController } from '@interfaces/ipc/controllers/ProjectController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'

vi.mock('electron', () => ({
  webUtils: { getPathForFile: (file: { path?: string }) => file.path ?? '' }
}))

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
describe('首页 IPC 与客户端', () => {
  it('选择保存位置无请求体，多余字段拒绝，取消 data 为 null', async () => {
    const projects = {
      chooseSaveLocation: vi.fn(async () => null),
      clearSaveLocation: vi.fn()
    }
    const controller = new ProjectController(projects as never, new IpcExceptionHandler(logger, new IpcErrorMapper()))
    expect(
      await controller.chooseSaveLocation(
        { directory: 'C:/secret' },
        { trusted: true, requestId: 'r' }
      )
    ).toMatchObject({ code: 4101 })
    expect(projects.chooseSaveLocation).not.toHaveBeenCalled()
    expect(
      await controller.chooseSaveLocation(undefined, { trusted: true, requestId: 'r' })
    ).toEqual({
      code: 2000,
      msg: '已取消选择',
      data: null
    })
    expect(
      await controller.clearSaveLocation(undefined, { trusted: true, requestId: 'r' })
    ).toEqual({
      code: 2000,
      msg: '操作成功',
      data: null
    })
    expect(projects.clearSaveLocation).toHaveBeenCalledTimes(1)
  })

  it('非法来源与任意路径在调用业务前拒绝，领域名称校验不由协议取代', async () => {
    const projects = {
      createProject: vi.fn(async () => ({
        status: 'completed' as const,
        projectId: 'p',
        name: 'n'
      })),
      importProject: vi.fn()
    }
    const controller = new ProjectController(projects, new IpcExceptionHandler(logger, new IpcErrorMapper()))
    const forbidden = await controller.createProject(
      { operationId: 'o', name: 'n' },
      { trusted: false, requestId: 'r' }
    )
    expect(forbidden.code).toBe(4102)
    const path = await controller.createProject(
      { operationId: 'o', name: 'n', directory: 'C:/secret' },
      { trusted: true, requestId: 'r' }
    )
    expect(path.code).toBe(4101)
    expect(projects.createProject).not.toHaveBeenCalled()
    await controller.createProject(
      { operationId: 'o', name: '  ' },
      { trusted: true, requestId: 'r' }
    )
    expect(projects.createProject).toHaveBeenCalledWith(
      { operationId: 'o', name: '  ', synopsis: undefined },
      undefined
    )
  })
  it('客户端先订阅再调用，过滤其他操作并在失败时清理', async () => {
    const sequence: string[] = []
    const callback = vi.fn()
    const unsubscribe = vi.fn(() => sequence.push('unsubscribe'))
    const bridge = {
      onProjectProgress(listener) {
        sequence.push('subscribe')
        listener({ operationId: 'other', stage: 'completed' })
        listener({ operationId: 'mine', stage: 'selecting' })
        return unsubscribe
      },
      async importProject() {
        sequence.push('invoke')
        throw new Error('ipc offline')
      }
    } as DesktopBridge
    const result = await new ProjectClientImpl(bridge).importProject(
      { operationId: 'mine' },
      callback
    )
    expect(result.code).toBe(5102)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(sequence).toEqual(['subscribe', 'invoke', 'unsubscribe'])
  })
  it('preload 只暴露具名能力，订阅提供释放函数', async () => {
    const invoke = vi.fn(async () => ({ code: 2000, msg: '成功' }))
    const dispose = vi.fn()
    const subscribe = vi.fn(() => dispose)
    const bridge = createDesktopBridge({ invoke, subscribe })
    await bridge.chooseSaveLocation()
    expect(invoke).toHaveBeenCalledWith('project:choose-save-location')
    await bridge.clearSaveLocation()
    expect(invoke).toHaveBeenCalledWith('project:clear-save-location')
    await bridge.importProject({ operationId: 'o' })
    expect(invoke).toHaveBeenCalledWith('project:import', { operationId: 'o' })
    await bridge.listProjects({ offset: 0, limit: 9 })
    expect(invoke).toHaveBeenCalledWith('project:list', { offset: 0, limit: 9 })
    await bridge.updateProjectTextFileBody({
      projectId: 'p',
      operationId: 'home-update-1',
      sourceId: 's',
      expectedSourceVersion: 'v1',
      content: { textKind: 'document', body: '正文' }
    })
    expect(invoke).toHaveBeenCalledWith('project-files:update-text-body', {
      projectId: 'p',
      operationId: 'home-update-1',
      sourceId: 's',
      expectedSourceVersion: 'v1',
      content: { textKind: 'document', body: '正文' }
    })
    await bridge.getLatestSceneGeneration({ projectId: 'p', sceneId: 's' })
    expect(invoke).toHaveBeenCalledWith('scene-generation:latest', { projectId: 'p', sceneId: 's' })
    bridge.onProjectProgress(() => {})()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('连接设置扩展 JSON 通道', () => {
  const access = { trusted: true, requestId: 'r' }
  const request = {
    providerId: 'openai-compatible' as const,
    baseUrl: 'https://service.example/v1',
    model: 'chosen',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    apiKey: { kind: 'replace' as const, value: 'draft-key' },
    extension: { kind: 'keep' as const }
  }
  it('只接受保留、设置和清空，超长与多余字段在调用前拒绝', async () => {
    const summary = {
      providerId: request.providerId,
      baseUrl: request.baseUrl,
      model: request.model,
      contextWindow: request.contextWindow,
      maxOutputTokens: request.maxOutputTokens,
      hasApiKey: true,
      hasExtension: false
    }
    const settings = {
      saveSettings: vi.fn(async () => summary),
      listModels: vi.fn(async () => ({ models: ['chosen'] }))
    }
    const controller = new ConnectionSettingsController(
      settings as never,
      new IpcExceptionHandler(logger, new IpcErrorMapper())
    )
    expect(
      await controller.saveSettings({ ...request, extension: { kind: 'drop' } }, access)
    ).toMatchObject({
      code: 4101
    })
    expect(
      await controller.saveSettings(
        { ...request, extension: { kind: 'set', value: 'x'.repeat(8193) } },
        access
      )
    ).toMatchObject({ code: 4101 })
    expect(await controller.saveSettings({ ...request, extra: true }, access)).toMatchObject({
      code: 4101
    })
    expect(settings.saveSettings).not.toHaveBeenCalled()
    expect(
      await controller.saveSettings(
        { ...request, extension: { kind: 'set', value: '{"defaultHeaders":{}}' } },
        access
      )
    ).toMatchObject({ code: 2000 })
    expect(settings.saveSettings).toHaveBeenCalledWith({
      ...request,
      temperature: undefined,
      topP: undefined,
      extension: { kind: 'set', value: '{"defaultHeaders":{}}' }
    })
    const withoutExtension = { ...request }
    delete withoutExtension.extension
    expect(await controller.saveSettings(withoutExtension, access)).toMatchObject({ code: 2000 })
    expect(settings.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ extension: { kind: 'keep' } })
    )
    expect(
      await controller.listModels(
        {
          providerId: request.providerId,
          baseUrl: request.baseUrl,
          apiKey: request.apiKey,
          extension: { kind: 'clear' }
        },
        access
      )
    ).toMatchObject({ code: 2000 })
  })
})

describe('工程工作区核对通道', () => {
  const access = { trusted: true, requestId: 'r' }
  const workspace = { projectId: 'p1', sceneId: 'scene-a', canvasId: 'canvas-a' }

  it('schema 只接受 projectId，控制器返回工作区身份', async () => {
    const projects = { ensureProjectWorkspace: vi.fn(async () => workspace) }
    const controller = new ProjectController(projects as never, new IpcExceptionHandler(logger, new IpcErrorMapper()))

    expect(
      await controller.ensureProjectWorkspace({ projectId: 'p1', directory: 'C:/secret' }, access)
    ).toMatchObject({ code: 4101 })
    expect(projects.ensureProjectWorkspace).not.toHaveBeenCalled()

    expect(await controller.ensureProjectWorkspace({ projectId: 'p1' }, access)).toEqual({
      code: 2000,
      msg: '工程工作区已核对',
      data: workspace
    })
    expect(projects.ensureProjectWorkspace).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('检查只接受 projectId，并原样返回就绪和身份', async () => {
    const inspection = { ready: false, sceneId: 'scene-a', canvasId: 'canvas-a' }
    const projects = { inspectProjectWorkspace: vi.fn(async () => inspection) }
    const controller = new ProjectController(projects as never, new IpcExceptionHandler(logger, new IpcErrorMapper()))
    expect(
      await controller.inspectProjectWorkspace({ projectId: 'p1', directory: 'C:/secret' }, access)
    ).toMatchObject({ code: 4101 })
    expect(projects.inspectProjectWorkspace).not.toHaveBeenCalled()
    expect(await controller.inspectProjectWorkspace({ projectId: 'p1' }, access)).toEqual({
      code: 2000,
      msg: '工程工作区已检查',
      data: inspection
    })
    const invoke = vi.fn(async () => ({ code: 2000, msg: '工程工作区已检查', data: inspection }))
    const bridge = createDesktopBridge({ invoke, subscribe: vi.fn(() => vi.fn()) })
    const client = new ProjectClientImpl(bridge)
    expect(await client.inspectProjectWorkspace({ projectId: 'p1' })).toEqual({
      code: 2000,
      msg: '工程工作区已检查',
      data: inspection
    })
    expect(invoke).toHaveBeenCalledWith('project:inspect-workspace', { projectId: 'p1' })
  })

  it('客户端原样返回工作区身份，通信中断不泄露内部信息', async () => {
    const invoke = vi.fn(async () => ({ code: 2000, msg: '工程工作区已核对', data: workspace }))
    const bridge = createDesktopBridge({ invoke, subscribe: vi.fn(() => vi.fn()) })
    await bridge.ensureProjectWorkspace({ projectId: 'p1' })
    expect(invoke).toHaveBeenCalledWith('project:ensure-workspace', { projectId: 'p1' })

    const client = new ProjectClientImpl(bridge)
    expect(await client.ensureProjectWorkspace({ projectId: 'p1' })).toEqual({
      code: 2000,
      msg: '工程工作区已核对',
      data: workspace
    })

    invoke.mockRejectedValueOnce(new Error('C:/secret/.git'))
    const offline = await client.ensureProjectWorkspace({ projectId: 'p1' })
    expect(offline.code).toBe(5102)
    expect(offline.msg).not.toContain('C:/secret')
    expect(offline.msg).not.toContain('.git')
  })
})

describe('项目列表通道与客户端', () => {
  const page = {
    entries: [
      { status: 'available' as const, id: 'p1', name: '月光工坊', synopsis: '一\n二' },
      { status: 'unavailable' as const, id: 'p2', code: 1308, msg: '所选目录不存在或无法读取' }
    ],
    total: 2,
    offset: 0,
    limit: 9
  }
  const query = { offset: 0, limit: 9 }

  it('列表入口先校验来源与分页协议，再原样返回页对象', async () => {
    const projects = { listProjects: vi.fn(async () => page) }
    const controller = new ProjectController(projects, new IpcExceptionHandler(logger, new IpcErrorMapper()))

    const forbidden = await controller.listProjects(query, { trusted: false, requestId: 'r' })
    expect(forbidden.code).toBe(4102)
    const extra = await controller.listProjects(
      { ...query, directory: 'C:/secret' },
      { trusted: true, requestId: 'r' }
    )
    expect(extra.code).toBe(4101)
    expect(projects.listProjects).not.toHaveBeenCalled()

    expect(await controller.listProjects(query, { trusted: true, requestId: 'r' })).toEqual({
      code: 2000,
      msg: '项目列表读取成功',
      data: page
    })
  })

  it('无登记时返回成功的空页，不冒充失败', async () => {
    const empty = { entries: [], total: 0, offset: 0, limit: 9 }
    const projects = { listProjects: vi.fn(async () => empty) }
    const controller = new ProjectController(projects, new IpcExceptionHandler(logger, new IpcErrorMapper()))

    expect(await controller.listProjects(query, { trusted: true, requestId: 'r' })).toEqual({
      code: 2000,
      msg: '项目列表读取成功',
      data: empty
    })
  })

  it('打开、重命名、移出走具名通道，多余字段拒绝', async () => {
    const projects = {
      openProject: vi.fn(async () => ({ id: 'p1', name: '月光工坊', synopsis: '' })),
      renameProject: vi.fn(async () => ({ id: 'p1', name: '新名', synopsis: '' })),
      unregisterProject: vi.fn(async () => ({ id: 'p1' }))
    }
    const controller = new ProjectController(projects, new IpcExceptionHandler(logger, new IpcErrorMapper()))
    const access = { trusted: true, requestId: 'r' }

    expect(await controller.openProject({ id: 'p1' }, access)).toMatchObject({
      code: 2000,
      data: { id: 'p1' }
    })
    expect(await controller.renameProject({ id: 'p1', directory: '/x' }, access)).toMatchObject({
      code: 4101
    })
    expect(projects.renameProject).not.toHaveBeenCalled()
    expect(await controller.unregisterProject({ id: 'p1' }, access)).toEqual({
      code: 2000,
      msg: '已从列表移出',
      data: { id: 'p1' }
    })
  })

  it('客户端放行完整页对象，结构不符或通信中断都按列表加载失败处理', async () => {
    const listProjects = vi.fn(async () => ({ code: 2000, msg: 'ok', data: page }))
    const client = new ProjectClientImpl({ listProjects } as unknown as DesktopBridge)

    expect(await client.listProjects(query)).toEqual({ code: 2000, msg: 'ok', data: page })

    for (const payload of [
      { code: 2000, msg: 'ok', data: page.entries },
      { code: 2000, msg: 'ok', data: [{ status: 'available', id: 'p1' }] },
      { code: 2000, msg: 'ok' },
      { code: 2000, msg: 'ok', data: '不是数组' },
      { code: 5103, msg: '系统异常，操作未完成', data: [] },
      { msg: '操作成功' }
    ]) {
      listProjects.mockResolvedValueOnce(payload)
      expect(await client.listProjects(query)).toEqual({
        code: 5102,
        msg: '项目列表加载失败，请重试'
      })
    }

    listProjects.mockResolvedValueOnce({ code: 1304, msg: '本机登记文件读取失败' })
    expect(await client.listProjects(query)).toEqual({
      code: 1304,
      msg: '本机登记文件读取失败'
    })

    listProjects.mockRejectedValueOnce(new Error('ipc offline'))
    const offline = await client.listProjects(query)
    expect(offline).toEqual({ code: 5102, msg: '项目列表加载失败，请重试' })
    expect(offline.msg).not.toContain('待确认')
  })
})

const INVOKE_CHANNELS = {
  chooseSaveLocation: 'project:choose-save-location',
  clearSaveLocation: 'project:clear-save-location',
  createProject: 'project:create',
  importProject: 'project:import',
  listProjects: 'project:list',
  openProject: 'project:open',
  renameProject: 'project:rename',
  unregisterProject: 'project:unregister',
  ensureProjectWorkspace: 'project:ensure-workspace',
  inspectProjectWorkspace: 'project:inspect-workspace',
  inspectProjectFiles: 'project-files:inspect',
  listProjectInputSources: 'project-files:list-input-sources',
  readProjectInputSources: 'project-files:read-input-sources',
  readProjectMedia: 'project-files:read-media',
  readSceneCanvasArrangement: 'scene-canvas:read-arrangement',
  createSceneCanvasSourceCard: 'scene-canvas:create-source-card',
  createSceneCanvasPromptCard: 'scene-canvas:create-prompt-card',
  createSceneCanvasFieldCard: 'scene-canvas:create-field-card',
  editSceneCanvasCard: 'scene-canvas:edit-card',
  editSceneCanvasPromptBody: 'scene-canvas:edit-prompt-body',
  bindSceneCanvasFieldCardPreset: 'scene-canvas:bind-field-card-preset',
  editSceneCanvasMediaRole: 'scene-canvas:edit-media-role',
  copySceneCanvasCard: 'scene-canvas:copy-card',
  deleteSceneCanvasCard: 'scene-canvas:delete-card',
  connectSceneCanvasCards: 'scene-canvas:connect-cards',
  disconnectSceneCanvasCards: 'scene-canvas:disconnect-cards',
  editSceneCanvasRelationName: 'scene-canvas:edit-relation-name',
  attachSceneCanvasRelationRecord: 'scene-canvas:attach-relation-record',
  detachSceneCanvasRelationRecord: 'scene-canvas:detach-relation-record',
  saveSceneCanvasArrangement: 'scene-canvas:save-arrangement',
  chooseProjectFiles: 'project-files:choose-files',
  importProjectFiles: 'project-files:import',
  openProjectFile: 'project-files:open',
  renameProjectFile: 'project-files:rename',
  deleteProjectFile: 'project-files:delete',
  createProjectTextFile: 'project-files:create-text',
  updateProjectTextFileBody: 'project-files:update-text-body',
  createProjectFolder: 'project-files:create-folder',
  copyProjectFile: 'project-files:copy-file',
  moveProjectFile: 'project-files:move-file',
  copyProjectFolder: 'project-files:copy-folder',
  readProjectFileOperation: 'project-files:read-operation',
  recoverProjectFileOperations: 'project-files:recover-operations',
  renameProjectFolder: 'project-files:rename-folder',
  readProjectFolderDeletionPlan: 'project-files:folder-deletion-plan',
  deleteProjectFolder: 'project-files:delete-folder',
  getSettingsSummary: 'connection:get-summary',
  testConnection: 'connection:test',
  saveSettings: 'connection:save',
  listModels: 'connection:list-models',
  listVersionHistory: 'project-versioning:list-history',
  undoVersionHistoryEntry: 'project-versioning:undo-history-entry',
  clearVersionHistory: 'project-versioning:clear-history',
  startSceneGeneration: 'scene-generation:start',
  retrySceneGenerationRepair: 'scene-generation:retry-repair',
  getSceneGenerationStatus: 'scene-generation:status',
  getLatestSceneGeneration: 'scene-generation:latest',
  replySceneGeneration: 'scene-generation:reply',
  pauseSceneGeneration: 'scene-generation:pause',
  resumeSceneGeneration: 'scene-generation:resume',
  cancelSceneGeneration: 'scene-generation:cancel',
  listSceneGenerationHistory: 'scene-generation:list-history',
  readSceneGenerationCheckpoint: 'scene-generation:read-checkpoint',
  forkSceneGeneration: 'scene-generation:fork',
  openSceneGenerationPreview: 'scene-generation:open-preview',
  closeSceneGenerationPreview: 'scene-generation:close-preview',
  subscribeSceneGenerationProgress: 'scene-generation:progress',
  readScenePreviewAvailability: 'scene-preview:availability',
  openScenePreview: 'scene-preview:open',
  preparePreviewStage: 'scene-preview:prepare',
  previewDialogueDraft: 'scene-preview:draft',
  saveDialogueChanges: 'scene-preview:save',
  readDialogueSaveSettlement: 'scene-preview:settlement',
  selectPreviewDialogue: 'scene-preview:select-dialogue',
  playPreviousDialogue: 'scene-preview:previous-dialogue',
  playNextDialogue: 'scene-preview:next-dialogue',
  closeScenePreview: 'scene-preview:close',
  subscribeScenePreviewRuntime: 'scene-preview:subscribe',
  readCandidatePreview: 'scene-preview:read-candidate',
  readCandidatePreviewEvent: 'scene-preview:candidate-event',
  exportSavedScene: 'scene-export:export-saved-scene',
  readLatestSavedSceneVersion: 'scene-export:read-latest-saved-scene-version',
  chooseSceneExportDirectory: 'scene-export:choose-directory',
  checkForUpdate: 'app-update:check',
  downloadUpdate: 'app-update:download',
  installUpdate: 'app-update:install',
  readUpdateStatus: 'app-update:read-status',
  openDirectory: 'system:open-directory'
} as const satisfies Record<string, string>

const EVENT_CHANNELS = {
  onProjectProgress: 'project:progress',
  onSceneGenerationProgress: 'scene-generation:progress',
  onScenePreviewRuntime: 'scene-preview:runtime',
  onCandidatePreviewReady: 'scene-preview:ready',
  onCandidatePreviewStageFailed: 'scene-preview:stage-failed',
  onCandidatePreviewInvalidated: 'scene-preview:invalidated',
  onAppUpdateStatus: 'app-update:status'
} as const satisfies Record<string, string>

const expectedMethods = [
  ...Object.keys(INVOKE_CHANNELS),
  ...Object.keys(EVENT_CHANNELS),
  'pathForDroppedFile'
].sort()

describe('DesktopBridge 单一通道清单基线', () => {
  it('preload 的 88 个 invoke、7 个订阅和 94 个唯一通道与冻结清单一致', () => {
    const bridge = createDesktopBridge({
      invoke: async () => ({ code: 2000, msg: '成功' }),
      subscribe: () => () => undefined
    })

    expect(Object.keys(bridge).sort()).toEqual(expectedMethods)

    const invokeChannels = Object.values(INVOKE_CHANNELS)
    const eventChannels = Object.values(EVENT_CHANNELS)
    expect(invokeChannels).toHaveLength(88)
    expect(eventChannels).toHaveLength(7)
    expect(new Set([...invokeChannels, ...eventChannels]).size).toBe(94)
    expect(invokeChannels.filter((channel) => (eventChannels as readonly string[]).includes(channel))).toEqual([
      'scene-generation:progress'
    ])
  })

  it('源通道与冻结协议一致', () => {
    expect(desktopBridgeChannels.invoke).toEqual(INVOKE_CHANNELS)
    expect(desktopBridgeChannels.event).toEqual(EVENT_CHANNELS)
  })

  it('订阅按冻结通道登记，退订后事件不再投递且不串通道', () => {
    const listenersByChannel = new Map<string, Set<(value: unknown) => void>>()
    const bridge = createDesktopBridge({
      invoke: async () => ({ code: 2000, msg: '成功' }),
      subscribe: (channel, listener) => {
        const listeners = listenersByChannel.get(channel) ?? new Set()
        listeners.add(listener)
        listenersByChannel.set(channel, listeners)
        return () => {
          listeners.delete(listener)
        }
      }
    })
    const received = new Map<string, unknown[]>()
    const releases: (() => void)[] = []

    for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
      const subscribe = bridge[method as keyof DesktopBridge] as unknown as (
        listener: (value: unknown) => void
      ) => () => void
      releases.push(
        subscribe((value) => {
          const values = received.get(channel) ?? []
          values.push(value)
          received.set(channel, values)
        })
      )
    }

    expect([...listenersByChannel.keys()]).toEqual(Object.values(EVENT_CHANNELS))

    const emit = (channel: string, value: unknown): void => {
      listenersByChannel.get(channel)?.forEach((listener) => listener(value))
    }
    for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
      emit(channel, { channel, method })
      expect(received.get(channel)).toEqual([{ channel, method }])
    }

    releases.forEach((release) => release())

    for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
      emit(channel, { channel, method: `${method}-after-release` })
    }
    for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
      expect(received.get(channel)).toEqual([{ channel, method }])
    }
  })

  it('拖入文件返回本机路径结果', async () => {
    const bridge = createDesktopBridge({
      invoke: async () => ({ code: 2000, msg: '成功' }),
      subscribe: () => () => undefined
    })
    const file = { path: 'D:/作品/封面.png' } as unknown as Parameters<
      DesktopBridge['pathForDroppedFile']
    >[0]

    await expect(bridge.pathForDroppedFile(file)).resolves.toEqual({
      code: 2000,
      msg: '已取得文件路径',
      data: 'D:/作品/封面.png'
    })
  })
})
