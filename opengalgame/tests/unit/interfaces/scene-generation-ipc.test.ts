import { describe, expect, it, vi } from 'vitest'

import type {
  CloseSceneGenerationCandidatePreviewDTO,
  ListSceneGenerationHistoryForSceneDTO,
  OpenSceneGenerationCandidatePreviewDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationCandidatePreviewService } from '@application/scene-generation/services/SceneGenerationCandidatePreviewService'
import type { SceneGenerationApplicationService } from '@application/scene-generation/services/SceneGenerationApplicationService'
import type { SceneGenerationControlService } from '@application/scene-generation/services/SceneGenerationControlService'
import type { SceneGenerationHistoryQueryService } from '@application/scene-generation/services/SceneGenerationHistoryQueryService'
import type { SceneGenerationLaunchService } from '@application/scene-generation/services/SceneGenerationLaunchService'
import type { SceneGenerationRenderQueryService } from '@application/scene-generation/services/SceneGenerationRenderQueryService'
import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { SCENE_GENERATION_START_CONFLICT_MESSAGE } from '@application/scene-generation/policies/SceneGenerationStartConflict'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'
import { createSceneGenerationFixture } from '@bootstrap/browser/sceneGenerationFixture'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import { SceneGenerationController } from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { registerSceneGenerationIpc } from '@interfaces/scene-generation/ipc/registerSceneGenerationIpc'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  sent: [] as { channel: string; value: unknown }[]
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
  webUtils: {
    getPathForFile: () => ''
  }
}))

const access = { trusted: true, requestId: 'req-1' }
const denied = { trusted: false, requestId: 'req-2' }

function status(sequence = 1): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'running',
    stage: 'generating',
    stageMessage: 'AI 正在生成候选脚本',
    attempt: 1,
    sequence,
    canPause: true,
    canResume: false,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'version-1',
      documentCount: 1,
      assetCount: 1,
      promptCount: 1,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, tokenLimit: 20 },
    previewAvailable: false
  }
}

function event(sequence: number, threadId = 'thread-1'): SceneGenerationRenderProgressEventVO {
  return { ...status(sequence), threadId, message: status(sequence).stageMessage }
}

function startRequest(): StartSceneGenerationDTO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    confirmedControls: [],
    policy: { maxCorrections: 1 }
  }
}

function repairRequest(): RetrySceneGenerationRepairDTO {
  return {
    ...startRequest(),
    repair: {
      sourceOperationId: 'operation-1',
      sourceThreadId: 'thread-1',
      sourceBranchId: 'branch-1',
      sourceCheckpointId: 'checkpoint-1',
      candidateSnapshotId: 'candidate-1',
      instruction: '把雨声停在离开站台时，不要贯穿整场'
    }
  }
}

interface GenerationServiceFixture {
  launch: SceneGenerationLaunchService
  renderQuery: SceneGenerationRenderQueryService
  control: SceneGenerationControlService
  history: SceneGenerationHistoryQueryService
  preview: SceneGenerationCandidatePreviewService
  generation: SceneGenerationApplicationService
  calls: string[]
  subscriptions: (() => void)[]
}

function services(): GenerationServiceFixture {
  const calls: string[] = []
  const subscriptions: (() => void)[] = []
  return {
    calls,
    subscriptions,
    launch: {
      startSceneGeneration: vi.fn(async () => {
        calls.push('start')
        return status()
      }),
      retrySceneGenerationRepair: vi.fn(async () => {
        calls.push('retryRepair')
        return status(2)
      })
    },
    renderQuery: {
      getSceneGenerationRenderStatus: vi.fn(async () => status(4)),
      findLatestSceneGeneration: vi.fn(async () => status(4)),
      subscribeSceneGenerationProgress: vi.fn((_request, publish) => {
        calls.push('subscribe')
        const unsubscribe = vi.fn(() => calls.push('unsubscribe'))
        subscriptions.push(unsubscribe)
        publish(event(1))
        publish(event(1, 'other-thread'))
        publish(event(2))
        return unsubscribe
      })
    },
    generation: {
      replySceneGenerationInteraction: vi.fn(async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-1',
        threadId: 'thread-1',
        branchId: 'branch-1',
        interactionId: 'interaction-1',
        replyId: 'reply-1',
        accepted: true as const
      }))
    },
    control: {
      pauseSceneGeneration: vi.fn(async () => status()),
      resumeSceneGeneration: vi.fn(async () => status()),
      cancelSceneGeneration: vi.fn(async () => status())
    },
    history: {
      listSceneGenerationHistory: vi.fn(),
      readSceneGenerationCheckpoint: vi.fn(async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-1',
        threadId: 'thread-1',
        branchId: 'branch-1',
        checkpointId: 'checkpoint-1',
        step: undefined,
        summary: 'say:内部脚本;',
        decisions: [],
        differences: [{ filePath: 'game/scene/start.txt' }],
        preview: {
          entryFile: 'game/scene/start.txt',
          files: ['game/scene/start.txt'],
          parserVersion: '1',
          commandLocations: [],
          assetLocations: [],
          validationReport: { issues: [] }
        },
        canView: true,
        canContinue: true
      })),
      listSceneGenerationHistoryForScene: vi.fn(
        async (): Promise<readonly SceneGenerationHistorySummaryVO[]> => [
          {
            projectId: 'project-1',
            sceneId: 'scene-1',
            operationId: 'operation-1',
            threadId: 'thread-1',
            branchId: 'branch-1',
            checkpointId: 'checkpoint-1',
            boundary: 'waitingReview',
            stage: 'waitingReview',
            message: '候选已就绪，等待你的决定',
            createdAt: '2026-10-20T00:00:00.000Z'
          }
        ]
      )
    },
    preview: {
      openSceneGenerationCandidatePreview: vi.fn(
        async (): Promise<SceneGenerationCandidatePreviewVO> => ({
          previewSessionId: 'preview-1',
          candidateSnapshotId: 'candidate-1',
          url: 'http://127.0.0.1:9/',
          expiresAt: '2026-10-20T00:10:00.000Z'
        })
      ),
      closeSceneGenerationCandidatePreview: vi.fn(async () => undefined)
    }
  }
}

function controller(partial = services()): {
  controller: SceneGenerationController
  logs: string[]
  services: GenerationServiceFixture
} {
  const logs: string[] = []
  const logger: LoggerGateway = {
    debug: (message) => logs.push(message),
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message, context) => logs.push(`${message}:${JSON.stringify(context)}`)
  }
  return {
    logs,
    services: partial,
    controller: new SceneGenerationController(partial, new IpcExceptionHandler(logger))
  }
}

describe('场景生成用户接口', () => {
  it('启动只接受稳定身份和策略，路径与过期范围在调用前拒绝', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    await expect(sceneGeneration.start(startRequest(), access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { operationId: 'operation-1', usage: { totalTokens: 7 } }
    })
    await expect(
      sceneGeneration.start({ ...startRequest(), directory: 'D:/secret' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(sceneGeneration.start(startRequest(), denied)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    const expired: SceneGenerationScopeDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'missing'
    }
    vi.mocked(app.renderQuery.getSceneGenerationRenderStatus).mockRejectedValueOnce(
      new AppException({ code: ErrorCodes.invalidRequest, msg: 'D:/secret 上的生成操作不存在' })
    )
    const missing = await sceneGeneration.status(expired, access)
    expect(missing).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(JSON.stringify(missing)).not.toContain('D:/secret')
    expect(app.launch.startSceneGeneration).toHaveBeenCalledTimes(1)
  })

  it('启动冲突原样透传 4103 与场景冲突文案', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    vi.mocked(app.launch.startSceneGeneration).mockRejectedValueOnce(
      new AppException({
        code: ErrorCodes.operationConflict,
        msg: SCENE_GENERATION_START_CONFLICT_MESSAGE
      })
    )

    await expect(sceneGeneration.start(startRequest(), access)).resolves.toMatchObject({
      code: ErrorCodes.operationConflict,
      msg: SCENE_GENERATION_START_CONFLICT_MESSAGE
    })
  })

  it('检查点和历史只返回安全摘要，回复返回当前渲染状态', async () => {
    const { controller: sceneGeneration } = controller()
    const checkpoint: ReadSceneGenerationCheckpointDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1'
    }
    const projected = await sceneGeneration.readCheckpoint(checkpoint, access)
    expect(projected.code).toBe(ErrorCodes.success)
    expect(JSON.stringify(projected)).not.toMatch(/say:|filePath|entryFile|game[/\\]/)
    const history: ListSceneGenerationHistoryForSceneDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      limit: 10
    }
    await expect(sceneGeneration.listHistory(history, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: [{ checkpointId: 'checkpoint-1', boundary: 'waitingReview' }]
    })
    const reply: ReplySceneGenerationInteractionDTO = {
      ...checkpoint,
      operationId: 'operation-1',
      interactionId: 'interaction-1',
      replyId: 'reply-1',
      reply: { kind: 'select', optionId: 'option-1', body: '保留现有对白' }
    }
    await expect(sceneGeneration.reply(reply, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { stage: 'generating', sequence: 4 }
    })
  })

  it('最近一次生成只按场景身份读取，运行中没有检查点也返回状态', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    const latest = { projectId: 'project-1', sceneId: 'scene-1' }
    await expect(sceneGeneration.latest(latest, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '生成状态已读取',
      data: { operationId: 'operation-1', state: 'running', canCancel: true }
    })
    expect(app.renderQuery.findLatestSceneGeneration).toHaveBeenCalledWith(latest)
    await expect(
      sceneGeneration.latest({ ...latest, operationId: 'operation-1' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(sceneGeneration.latest({ projectId: 'project-1' }, access)).resolves.toMatchObject(
      {
        code: ErrorCodes.invalidRequest
      }
    )
    expect(app.renderQuery.findLatestSceneGeneration).toHaveBeenCalledTimes(1)
    await expect(sceneGeneration.latest(latest, denied)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    vi.mocked(app.renderQuery.findLatestSceneGeneration).mockResolvedValueOnce(null)
    await expect(sceneGeneration.latest(latest, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: null
    })
  })

  it('latest 通道从预加载桥传到渲染查询，并随注销释放', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    const sender = {
      id: 9,
      isDestroyed: () => false,
      send: () => undefined,
      once: vi.fn()
    }
    const frame = { url: 'http://127.0.0.1:5173/' }
    const window = {
      isDestroyed: () => false,
      webContents: Object.assign(sender, { mainFrame: frame })
    }
    const detach = registerSceneGenerationIpc({
      sceneGeneration,
      getWindow: () => window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    const handler = ipc.handlers.get('scene-generation:latest')
    expect(handler).toBeDefined()
    const request = { projectId: 'project-1', sceneId: 'scene-1' }
    await expect(handler?.({ sender, senderFrame: frame }, request)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { operationId: 'operation-1' }
    })
    expect(app.renderQuery.findLatestSceneGeneration).toHaveBeenCalledWith(request)
    const invoke = vi.fn(async (channel: string, input: unknown) => {
      expect(channel).toBe('scene-generation:latest')
      expect(input).toBe(request)
      return { code: ErrorCodes.success, msg: '生成状态已读取', data: status(5) }
    })
    const bridge = createDesktopBridge({ invoke, subscribe: vi.fn(() => () => undefined) })
    await expect(new SceneGenerationClientImpl(bridge).latest(request)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { operationId: 'operation-1', state: 'running', sequence: 5 }
    })
    expect(invoke).toHaveBeenCalledWith('scene-generation:latest', request)
    detach()
    expect(ipc.handlers.has('scene-generation:latest')).toBe(false)
  })

  it('进度按操作范围过滤并按序号去重，断线后重新查询状态', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    const scope = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1'
    }
    const seen: number[] = []
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, value: unknown) => ipc.sent.push({ channel, value }),
      once: vi.fn()
    }
    const frame = { url: 'http://127.0.0.1:5173/' }
    const window = {
      isDestroyed: () => false,
      webContents: Object.assign(sender, { mainFrame: frame })
    }
    const detach = registerSceneGenerationIpc({
      sceneGeneration,
      getWindow: () => window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    expect(ipc.handlers.has('scene-generation:progress')).toBe(true)
    const subscribed = await ipc.handlers.get('scene-generation:progress')?.(
      { sender, senderFrame: frame },
      scope
    )
    expect(subscribed).toMatchObject({ code: ErrorCodes.success, data: null })
    const subscribeRequested: unknown[] = []
    const client = new SceneGenerationClientImpl({
      onSceneGenerationProgress: (
        listener: (value: SceneGenerationRenderProgressEventVO) => void
      ) => {
        for (const value of [event(1), event(1), event(1, 'other-thread'), event(2)])
          listener(value)
        return () => undefined
      },
      subscribeSceneGenerationProgress: vi.fn(async (request: unknown) => {
        subscribeRequested.push(request)
        return { code: ErrorCodes.success, msg: '已订阅', data: null }
      }),
      getSceneGenerationStatus: vi.fn(async () => ({
        code: ErrorCodes.success,
        msg: '状态已读取',
        data: status(4)
      }))
    } as never)
    const stop = client.subscribeProgress(scope, (value) => seen.push(value.sequence))
    stop()
    expect(seen).toEqual([1, 2])
    await vi.waitFor(() => expect(subscribeRequested).toEqual([scope]))
    await expect(client.reconnect(scope)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { sequence: 4 }
    })
    expect(app.calls).toContain('subscribe')
    detach()
    expect(ipc.handlers.size).toBe(0)
    expect(app.subscriptions).toHaveLength(1)
    expect(app.calls).toContain('unsubscribe')
  })

  it('预览只接受绑定身份，浏览器桥明确不支持且不返回成功', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    const open: OpenSceneGenerationCandidatePreviewDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'candidate-1'
    }
    await expect(sceneGeneration.openPreview(open, denied)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    await expect(sceneGeneration.openPreview(open, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { previewSessionId: 'preview-1', url: 'http://127.0.0.1:9/' }
    })
    const close: CloseSceneGenerationCandidatePreviewDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      previewSessionId: 'preview-1'
    }
    await expect(sceneGeneration.closePreview(close, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: null
    })
    const bridge = createDesktopBridge({
      invoke: vi.fn(async (channel) => ({ code: ErrorCodes.success, msg: channel, data: null })),
      subscribe: vi.fn(() => () => undefined)
    })
    expect(Object.keys(bridge)).toEqual(
      expect.arrayContaining(['startSceneGeneration', 'onSceneGenerationProgress'])
    )
    expect(Object.keys(bridge)).not.toContain('invoke')
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })
    const browser = createBrowserDesktopBridge()
    await expect(browser.startSceneGeneration(startRequest())).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    const resume: ResumeSceneGenerationDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1'
    }
    await expect(browser.resumeSceneGeneration(resume)).resolves.not.toMatchObject({
      code: ErrorCodes.success
    })
    expect(app.preview.openSceneGenerationCandidatePreview).toHaveBeenCalledTimes(1)
  })

  it('修复重跑原样传递来源身份与确认正文，拒绝路径和未知字段', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    const request = repairRequest()
    await expect(sceneGeneration.retryRepair(request, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '修复重跑已启动',
      data: { operationId: 'operation-1', sequence: 2 }
    })
    expect(app.launch.retrySceneGenerationRepair).toHaveBeenCalledWith(request)
    await expect(
      sceneGeneration.retryRepair({ ...request, outputPath: 'D:/secret/start.txt' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneGeneration.retryRepair(
        { ...request, repair: { ...request.repair, checkpointPath: 'D:/secret/checkpoint' } },
        access
      )
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(sceneGeneration.retryRepair(request, denied)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    vi.mocked(app.launch.retrySceneGenerationRepair).mockRejectedValueOnce(
      new AppException({ code: ErrorCodes.invalidRequest, msg: 'D:/secret 的修复记录不存在' })
    )
    const unsafe = await sceneGeneration.retryRepair(request, access)
    expect(unsafe.code).toBe(ErrorCodes.invalidRequest)
    expect(JSON.stringify(unsafe)).not.toContain('D:/secret')
    expect(app.launch.retrySceneGenerationRepair).toHaveBeenCalledTimes(2)
  })

  it('retry-repair 通道从预加载桥传到启动服务，并随注销释放', async () => {
    const { controller: sceneGeneration, services: app } = controller()
    const sender = {
      id: 8,
      isDestroyed: () => false,
      send: () => undefined,
      once: vi.fn()
    }
    const frame = { url: 'http://127.0.0.1:5173/' }
    const window = {
      isDestroyed: () => false,
      webContents: Object.assign(sender, { mainFrame: frame })
    }
    const detach = registerSceneGenerationIpc({
      sceneGeneration,
      getWindow: () => window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    const handler = ipc.handlers.get('scene-generation:retry-repair')
    expect(handler).toBeDefined()
    const request = repairRequest()
    await expect(handler?.({ sender, senderFrame: frame }, request)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { operationId: 'operation-1' }
    })
    expect(app.launch.retrySceneGenerationRepair).toHaveBeenCalledWith(request)
    const invoke = vi.fn(async (channel: string, input: unknown) => {
      expect(input).toBe(request)
      return { code: ErrorCodes.success, msg: channel, data: status(2) }
    })
    const bridge = createDesktopBridge({ invoke, subscribe: vi.fn(() => () => undefined) })
    await expect(new SceneGenerationClientImpl(bridge).retryRepair(request)).resolves.toMatchObject(
      { code: ErrorCodes.success, data: { state: 'running', sequence: 2 } }
    )
    expect(invoke).toHaveBeenCalledWith('scene-generation:retry-repair', request)
    detach()
    expect(ipc.handlers.has('scene-generation:retry-repair')).toBe(false)
  })
})

describe('场景生成浏览器夹具的修复重跑', () => {
  function fixtureRepair(): RetrySceneGenerationRepairDTO {
    return {
      ...repairRequest(),
      repair: {
        sourceOperationId: 'fixture-operation',
        sourceThreadId: 'fixture-thread',
        sourceBranchId: 'fixture-branch',
        sourceCheckpointId: 'fixture-checkpoint',
        candidateSnapshotId: 'fixture-candidate',
        instruction: '把雨声停在离开站台时，不要贯穿整场'
      }
    }
  }

  it('只接受失败来源的完整身份，成功后回到运行中', () => {
    const fixture = createSceneGenerationFixture('failed')
    expect(fixture).not.toBeNull()
    const request = fixtureRepair()
    expect(fixture?.retryRepair(request)).toMatchObject({
      code: ErrorCodes.success,
      data: { state: 'running', stage: 'generating' }
    })

    const stale = createSceneGenerationFixture('failed')
    expect(
      stale?.retryRepair({
        ...request,
        repair: { ...request.repair, candidateSnapshotId: 'other-candidate' }
      })
    ).toMatchObject({ code: ErrorCodes.invalidRequest })

    const review = createSceneGenerationFixture('review')
    expect(review?.retryRepair(request)).toMatchObject({ code: ErrorCodes.operationConflict })
  })

  it('浏览器桥把页面请求交给夹具，未启用夹具时明确拒绝', async () => {
    vi.stubGlobal('window', { location: { search: '?generation=failed' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })
    const browser = createBrowserDesktopBridge()
    const request = fixtureRepair()
    await expect(browser.retrySceneGenerationRepair(request)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { state: 'running' }
    })
    vi.stubGlobal('window', { location: { search: '' } })
    const blocked = createBrowserDesktopBridge()
    await expect(blocked.retrySceneGenerationRepair(request)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    vi.unstubAllGlobals()
  })
})
