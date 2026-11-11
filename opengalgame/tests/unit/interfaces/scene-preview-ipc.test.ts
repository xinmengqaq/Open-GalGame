import { describe, expect, it, vi } from 'vitest'

import type {
  PreviewDialogueDraftDTO,
  SaveDialogueChangesDTO
} from '@application/scene-preview/dto/DialogueSaveDTO'
import type { ReadCandidatePreviewDTO } from '@application/scene-preview/dto/ReadCandidatePreviewDTO'
import type { SceneCandidatePreviewApplicationService } from '@application/scene-preview/services/SceneCandidatePreviewApplicationService'
import type { ScenePreviewApplicationService } from '@application/scene-preview/services/ScenePreviewApplicationService'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type {
  PreviewErrorVO,
  PreviewRuntimeEventVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ScenePreviewErrorCodes } from '@domain/scene-preview/errors/ScenePreviewErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { ScenePreviewClientImpl } from '@interfaces/scene-preview/client/ScenePreviewClientImpl'
import { ScenePreviewController } from '@interfaces/scene-preview/ipc/ScenePreviewController'
import {
  registerScenePreviewIpc,
  releaseScenePreviewSubscriptions
} from '@interfaces/scene-preview/ipc/registerScenePreviewIpc'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'
import { parsePreviewCommandResult } from '@interfaces/scene-preview/contracts/ScenePreviewResponseSchema'

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
  webUtils: { getPathForFile: () => '' }
}))

const access = { trusted: true, requestId: 'req-1' }
const denied = { trusted: false, requestId: 'req-2' }
const fixedChannels = [
  'scene-preview:availability',
  'scene-preview:open',
  'scene-preview:prepare',
  'scene-preview:draft',
  'scene-preview:save',
  'scene-preview:settlement',
  'scene-preview:select-dialogue',
  'scene-preview:previous-dialogue',
  'scene-preview:next-dialogue',
  'scene-preview:close',
  'scene-preview:subscribe',
  'scene-preview:read-candidate',
  'scene-preview:candidate-event'
]

function basis() {
  return { digest: 'digest-1', parserVersion: '4.6.5', engineVersion: '4.6.5' }
}

function capabilityFailure(): PreviewErrorVO {
  return {
    code: 'engineCapabilityUnavailable',
    message: '当前舞台不能暂停、继续、捕获或恢复',
    recovery: 'none'
  }
}

function session(): ScenePreviewSessionVO {
  return {
    previewSessionId: 'preview-1',
    projectId: 'project-1',
    sceneId: 'scene-1',
    sceneName: 'start',
    contentBasis: basis(),
    lockState: 'editable',
    dialogues: [{ dialogueId: '1', text: '原文', editable: true }],
    issues: []
  }
}

function candidate(): CandidatePreviewVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    sceneName: 'start',
    readOnly: true,
    candidate: {
      previewSessionId: 'candidate-1',
      candidateSnapshotId: 'snapshot-1',
      expiresAt: '2026-10-24T00:15:00.000Z'
    },
    contentBasis: basis(),
    issues: []
  }
}

function stageEvent(sequence: number, previewSessionId = 'preview-1'): PreviewRuntimeEventVO {
  return {
    type: 'stage',
    previewSessionId,
    contentBasis: basis(),
    runtimeGeneration: 1,
    sequence,
    phase: 'playing',
    position: { kind: 'dialogue', dialogueId: '1' }
  }
}

interface PreviewServiceFixture {
  current: ScenePreviewApplicationService
  candidate: SceneCandidatePreviewApplicationService
  calls: string[]
  subscriptions: (() => void)[]
  publish: ((event: PreviewRuntimeEventVO) => void) | undefined
}

function services(): PreviewServiceFixture {
  const calls: string[] = []
  const subscriptions: (() => void)[] = []
  const fixture: PreviewServiceFixture = {
    calls,
    subscriptions,
    publish: undefined,
    current: {
      readScenePreviewAvailability: vi.fn(async () => {
        calls.push('availability')
        return { status: 'available' as const }
      }),
      openScenePreview: vi.fn(async () => {
        calls.push('open')
        return session()
      }),
      preparePreviewStage: vi.fn(async () => {
        calls.push('prepare')
        return { status: 'failed' as const, failure: capabilityFailure() }
      }),
      previewDialogueDraft: vi.fn(async () => {
        calls.push('draft')
        return { status: 'unavailable' as const, reason: 'runtimeNotReady' as const }
      }),
      saveDialogueChanges: vi.fn(async () => {
        calls.push('save')
        return {
          status: 'rejected' as const,
          failure: {
            code: 'engineCapabilityUnavailable' as const,
            message: '当前舞台不能暂停、继续或准确恢复',
            recovery: 'none' as const
          }
        }
      }),
      readDialogueSaveSettlement: vi.fn(async () => {
        calls.push('settlement')
        return {
          status: 'notFound' as const,
          request: { projectId: 'project-1', sceneId: 'scene-1', requestId: 'request-1' }
        }
      }),
      selectPreviewDialogue: vi.fn(async () => {
        calls.push('select')
        return { status: 'failed' as const, failure: capabilityFailure() }
      }),
      playPreviousDialogue: vi.fn(async () => {
        calls.push('previous')
        return { status: 'failed' as const, failure: capabilityFailure() }
      }),
      playNextDialogue: vi.fn(async () => {
        calls.push('next')
        return { status: 'failed' as const, failure: capabilityFailure() }
      }),
      subscribePreviewRuntime: vi.fn((_request, listener) => {
        calls.push('subscribe')
        fixture.publish = listener
        const unsubscribe = vi.fn(() => calls.push('unsubscribe'))
        subscriptions.push(unsubscribe)
        if (calls.filter((call) => call === 'subscribe').length === 1) {
          listener(stageEvent(1))
          listener(stageEvent(0))
          listener(stageEvent(1, 'other-session'))
          listener(stageEvent(2))
        }
        return unsubscribe
      }),
      closeScenePreview: vi.fn(async () => {
        calls.push('close')
        return null
      })
    },
    candidate: {
      readCandidatePreview: vi.fn(async () => {
        calls.push('candidate')
        return candidate()
      })
    }
  }
  return fixture
}

function controller(partial = services()): {
  controller: ScenePreviewController
  logs: string[]
  services: PreviewServiceFixture
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
    controller: new ScenePreviewController(
      partial.current,
      partial.candidate,
      new IpcExceptionHandler(logger)
    )
  }
}

function runtimeSequence(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('sequence' in value)) return undefined
  return typeof value.sequence === 'number' ? value.sequence : undefined
}

function trustedWindow(id = 7) {
  const sender = {
    id,
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => ipc.sent.push({ channel, value }),
    once: vi.fn()
  }
  const frame = { url: 'http://127.0.0.1:5173/' }
  const window = {
    isDestroyed: () => false,
    webContents: Object.assign(sender, { mainFrame: frame })
  }
  return { sender, frame, window }
}

describe('场景预览用户接口', () => {
  it('固定通道覆盖可用性到关闭，能力不可用原样返回且不因加载冒充成功', async () => {
    const { controller: scenePreview, services: app } = controller()
    const detach = registerScenePreviewIpc({
      scenePreview,
      getWindow: () => trustedWindow().window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    expect([...ipc.handlers.keys()].sort()).toEqual([...fixedChannels].sort())
    expect(ipc.handlers.has('scene-preview:seek')).toBe(false)

    await expect(
      scenePreview.readAvailability({ projectId: 'project-1', sceneId: 'scene-1' }, access)
    ).resolves.toMatchObject({
      code: ErrorCodes.success,
      msg: '预览可用性已读取',
      data: { status: 'available' }
    })
    await expect(
      scenePreview.open({ projectId: 'project-1', sceneId: 'scene-1' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.success, data: { previewSessionId: 'preview-1' } })
    const prepared = await scenePreview.prepare({ previewSessionId: 'preview-1' }, access)
    expect(prepared).toMatchObject({
      code: ErrorCodes.success,
      data: { status: 'failed', failure: { code: 'engineCapabilityUnavailable' } }
    })
    expect(JSON.stringify(prepared)).not.toContain('stageUrl')
    expect(app.calls).toEqual(['availability', 'open', 'prepare'])
    detach()
    expect(ipc.handlers.size).toBe(0)
  })

  it('请求边界拒绝空白、多余字段、路径、生成身份和非法 requestId', async () => {
    const { controller: scenePreview, services: app } = controller()
    const save: SaveDialogueChangesDTO = {
      previewSessionId: 'preview-1',
      requestId: 'request-1',
      baseContentBasis: basis(),
      edits: [{ dialogueId: '1', text: '新正文' }]
    }
    await expect(scenePreview.save(save, access)).resolves.toMatchObject({
      code: ErrorCodes.success
    })
    await expect(scenePreview.save({ ...save, requestId: '   ' }, access)).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      scenePreview.save({ ...save, operationId: 'generation-1' }, access)
    ).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      scenePreview.save({ ...save, edits: [{ dialogueId: '1', text: '新正文', line: 3 }] }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      scenePreview.open({ projectId: 'project-1', sceneId: 'scene-1', path: 'D:/secret' }, access)
    ).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      scenePreview.readCandidate(
        {
          projectId: 'project-1',
          sceneId: 'scene-1',
          previewSessionId: 'candidate-1',
          candidateSnapshotId: 'snapshot-1'
        },
        access
      )
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      scenePreview.open({ projectId: 'project-1', sceneId: 'scene-1' }, denied)
    ).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    expect(app.calls).toEqual(['save'])
  })

  it('已知错误保留安全码，路径消息和未知异常不泄漏内部事实', async () => {
    const { controller: scenePreview, services: app, logs } = controller()
    vi.mocked(app.candidate.readCandidatePreview).mockRejectedValueOnce(
      new AppException({
        code: ScenePreviewErrorCodes.candidateSessionMissing,
        msg: '候选预览会话不存在'
      })
    )
    await expect(
      scenePreview.readCandidate(
        { projectId: 'project-1', sceneId: 'scene-1', previewSessionId: 'candidate-1' },
        access
      )
    ).resolves.toMatchObject({
      code: ScenePreviewErrorCodes.candidateSessionMissing,
      msg: '候选预览会话不存在'
    })
    vi.mocked(app.current.openScenePreview).mockRejectedValueOnce(
      new AppException({
        code: ErrorCodes.invalidRequest,
        msg: 'D:/secret/game/scene/start.txt 无法读取'
      })
    )
    const leaked = await scenePreview.open({ projectId: 'project-1', sceneId: 'scene-1' }, access)
    expect(leaked).toEqual({ code: ErrorCodes.invalidRequest, msg: '系统异常，操作未完成' })
    expect(JSON.stringify(leaked)).not.toContain('secret')
    vi.mocked(app.current.selectPreviewDialogue).mockRejectedValueOnce(
      new Error('stack at D:/secret')
    )
    const unknown = await scenePreview.selectDialogue(
      { previewSessionId: 'preview-1', expectedRuntimeGeneration: 1, dialogueId: '1' },
      access
    )
    expect(unknown).toEqual({ code: ErrorCodes.internalError, msg: '系统异常，操作未完成' })
    expect(logs.join('\n')).not.toContain('secret')
    expect(logs.some((entry) => entry.includes('请求执行失败'))).toBe(true)
  })

  it('订阅按会话和代次过滤，重新订阅和关闭都退订，listener 不进入 IPC 载荷', async () => {
    const { controller: scenePreview, services: app } = controller()
    const trusted = trustedWindow()
    const detach = registerScenePreviewIpc({
      scenePreview,
      getWindow: () => trusted.window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    const scope = { previewSessionId: 'preview-1', projectId: 'project-1', sceneId: 'scene-1' }
    const subscribed = await ipc.handlers.get('scene-preview:subscribe')?.(
      { sender: trusted.sender, senderFrame: trusted.frame },
      scope
    )
    expect(subscribed).toMatchObject({ code: ErrorCodes.success, data: null })
    expect(ipc.sent.map((item) => item.channel)).toEqual([
      'scene-preview:runtime',
      'scene-preview:runtime'
    ])
    expect(ipc.sent.map((item) => runtimeSequence(item.value))).toEqual([1, 2])
    expect(JSON.stringify(ipc.sent)).not.toContain('[native code]')

    ipc.sent.length = 0
    await ipc.handlers.get('scene-preview:subscribe')?.(
      { sender: trusted.sender, senderFrame: trusted.frame },
      scope
    )
    expect(app.calls.filter((call) => call === 'unsubscribe')).toHaveLength(1)
    app.publish?.({
      type: 'failed',
      previewSessionId: 'preview-1',
      contentBasis: basis(),
      runtimeGeneration: 0,
      sequence: 3,
      failure: capabilityFailure(),
      lastConfirmed: { kind: 'unknown' }
    })
    expect(ipc.sent).toEqual([])

    await ipc.handlers.get('scene-preview:close')?.(
      { sender: trusted.sender, senderFrame: trusted.frame },
      { previewSessionId: 'preview-1' }
    )
    expect(app.calls).toContain('close')
    expect(app.calls.filter((call) => call === 'unsubscribe')).toHaveLength(2)
    detach()
    releaseScenePreviewSubscriptions()
  })

  it('订阅非法或失效会话返回安全错误，不留下 listener', async () => {
    const { controller: scenePreview, services: app, logs } = controller()
    const trusted = trustedWindow()
    const detach = registerScenePreviewIpc({
      scenePreview,
      getWindow: () => trusted.window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    const released: string[] = []
    vi.mocked(app.current.subscribePreviewRuntime)
      .mockImplementationOnce(() => {
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '预览会话不存在',
          cause: 'D:/secret/session'
        })
      })
      .mockImplementationOnce(() => {
        released.push('subscribed')
        throw new Error('stack at D:/secret/runtime')
      })
    const missing = await ipc.handlers.get('scene-preview:subscribe')?.(
      { sender: trusted.sender, senderFrame: trusted.frame },
      { previewSessionId: 'missing', projectId: 'project-1', sceneId: 'scene-1' }
    )
    expect(missing).toEqual({ code: ErrorCodes.invalidRequest, msg: '预览会话不存在' })
    expect(JSON.stringify(missing)).not.toContain('secret')
    expect(JSON.stringify(missing)).not.toContain('stack')
    const crashed = await ipc.handlers.get('scene-preview:subscribe')?.(
      { sender: trusted.sender, senderFrame: trusted.frame },
      { previewSessionId: 'preview-1', projectId: 'project-1', sceneId: 'scene-1' }
    )
    expect(crashed).toEqual({ code: ErrorCodes.internalError, msg: '系统异常，操作未完成' })
    expect(JSON.stringify(crashed)).not.toContain('secret')
    expect(released).toEqual(['subscribed'])
    expect(app.subscriptions).toHaveLength(0)
    expect(logs.join('\n')).not.toContain('secret')
    detach()
    releaseScenePreviewSubscriptions()
  })

  it('候选事件按会话补投，范围不符或无事件返回 null 且不泄漏路径', async () => {
    const { controller: scenePreview } = controller()
    const trusted = trustedWindow()
    const ready = {
      type: 'ready' as const,
      sequence: 1,
      projectId: 'project-1',
      sceneId: 'scene-1',
      previewSessionId: 'candidate-1',
      candidateSnapshotId: 'snapshot-1',
      message: '游戏已就绪'
    }
    const candidatePreview = {
      subscribeCandidatePreviewEvents: () => () => undefined,
      readCandidatePreviewEvent: (previewSessionId: string) =>
        previewSessionId === 'candidate-1' ? ready : undefined
    } as never
    const detach = registerScenePreviewIpc({
      scenePreview,
      candidatePreview,
      getWindow: () => trusted.window as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    const context = { sender: trusted.sender, senderFrame: trusted.frame }
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      previewSessionId: 'candidate-1'
    }
    await expect(
      ipc.handlers.get('scene-preview:candidate-event')?.(context, request)
    ).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { type: 'ready', sequence: 1, message: '游戏已就绪' }
    })
    await expect(
      ipc.handlers.get('scene-preview:candidate-event')?.(context, {
        ...request,
        sceneId: 'other-scene'
      })
    ).resolves.toMatchObject({ code: ErrorCodes.success, data: null })
    await expect(
      ipc.handlers.get('scene-preview:candidate-event')?.(context, {
        ...request,
        previewSessionId: 'missing'
      })
    ).resolves.toMatchObject({ code: ErrorCodes.success, data: null })
    await expect(
      ipc.handlers.get('scene-preview:candidate-event')?.(
        { sender: trusted.sender, senderFrame: trusted.frame },
        { ...request, path: 'D:/secret' }
      )
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    const deniedResult = await ipc.handlers.get('scene-preview:candidate-event')?.(
      {
        sender: { ...trusted.sender, mainFrame: { url: 'http://evil/' } },
        senderFrame: { url: 'http://evil/' }
      },
      request
    )
    expect(deniedResult).toMatchObject({ code: ErrorCodes.forbidden })
    expect(JSON.stringify(deniedResult)).not.toContain('secret')
    detach()
    releaseScenePreviewSubscriptions()
  })

  it('客户端校验响应并丢弃旧事件，浏览器桥固定返回不支持', async () => {
    const bridge = createDesktopBridge({
      invoke: async (channel, input) => {
        if (channel === 'scene-preview:subscribe')
          return { code: ErrorCodes.success, msg: '预览运行时已订阅', data: null }
        if (channel === 'scene-preview:prepare') {
          return {
            code: ErrorCodes.success,
            msg: '舞台已准备',
            data: {
              status: 'ready',
              stageUrl: 'http://127.0.0.1:9/?secret',
              stage: { previewSessionId: 'preview-1' }
            }
          }
        }
        return { code: ErrorCodes.success, msg: 'ok', data: input }
      },
      subscribe: (_channel, listener) => {
        listener(stageEvent(2))
        listener(stageEvent(1))
        listener({ type: 'ready', previewSessionId: 'candidate-1' })
        return () => undefined
      }
    })
    const client = new ScenePreviewClientImpl(bridge)
    const seen: number[] = []
    client.subscribeRuntime(
      { previewSessionId: 'preview-1', projectId: 'project-1', sceneId: 'scene-1' },
      (event) => {
        if (event.type === 'stage') seen.push(event.sequence)
      }
    )
    expect(seen).toEqual([2])
    const prepared = await client.prepareStage({ previewSessionId: 'preview-1' })
    expect(prepared.code).toBe(ErrorCodes.communicationFailed)
    expect(JSON.stringify(prepared)).not.toContain('stageUrl')
    expect(JSON.stringify(prepared)).not.toContain('127.0.0.1')
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })

    const browser = createBrowserDesktopBridge()
    await expect(
      browser.readScenePreviewAvailability({ projectId: 'project-1', sceneId: 'scene-1' })
    ).resolves.toMatchObject({ code: ErrorCodes.forbidden, msg: '当前环境不支持场景预览' })
    const draft: PreviewDialogueDraftDTO = {
      previewSessionId: 'preview-1',
      expectedRuntimeGeneration: 1,
      dialogueId: '1',
      editRevision: 1,
      text: '草稿'
    }
    await expect(browser.previewDialogueDraft(draft)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    const candidateRequest: ReadCandidatePreviewDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      previewSessionId: 'candidate-1'
    }
    await expect(browser.readCandidatePreview(candidateRequest)).resolves.toMatchObject({
      code: ErrorCodes.forbidden,
      msg: '当前环境不支持场景预览'
    })
  })

  it('候选预览晚订阅补投已缓存事实并按序号去重', async () => {
    const scope: ReadCandidatePreviewDTO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      previewSessionId: 'candidate-1'
    }
    const ready = {
      type: 'ready' as const,
      sequence: 1,
      projectId: 'project-1',
      sceneId: 'scene-1',
      previewSessionId: 'candidate-1',
      candidateSnapshotId: 'snapshot-1',
      message: '游戏已就绪'
    }
    const invalidated = {
      type: 'invalidated' as const,
      sequence: 2,
      projectId: 'project-1',
      sceneId: 'scene-1',
      previewSessionId: 'candidate-1',
      candidateSnapshotId: 'snapshot-1'
    }
    let replay: unknown = invalidated
    const bridge = createDesktopBridge({
      invoke: async (channel) => {
        if (channel === 'scene-preview:candidate-event') {
          return { code: ErrorCodes.success, msg: '候选预览事件已读取', data: replay }
        }
        return { code: ErrorCodes.success, msg: 'ok', data: null }
      },
      subscribe: (channel, listener) => {
        if (channel === 'scene-preview:ready') listener(ready)
        return () => undefined
      }
    })
    const client = new ScenePreviewClientImpl(bridge)
    const delivered: string[] = []
    const stop = client.subscribeCandidatePreview(scope, (event) =>
      delivered.push(`${event.type}:${event.sequence}`)
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(delivered).toEqual(['ready:1', 'invalidated:2'])
    stop()

    replay = ready
    const duplicate: string[] = []
    const stopped = client.subscribeCandidatePreview(scope, (event) =>
      duplicate.push(`${event.type}:${event.sequence}`)
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(duplicate).toEqual(['ready:1'])
    stopped()
  })

  it('旧代次选句的失败码经协议解析后仍是 staleRuntimeGeneration', async () => {
    const payload = {
      code: ErrorCodes.success,
      msg: '选句未确认',
      data: {
        status: 'failed' as const,
        failure: {
          code: 'staleRuntimeGeneration' as const,
          message: '舞台已经更换，请使用当前舞台',
          recovery: 'none' as const
        }
      }
    }
    expect(parsePreviewCommandResult(payload)).toMatchObject({
      code: ErrorCodes.success,
      data: { status: 'failed', failure: { code: 'staleRuntimeGeneration' } }
    })
    const bridge = createDesktopBridge({
      invoke: async () => payload,
      subscribe: () => () => undefined
    })
    const client = new ScenePreviewClientImpl(bridge)
    await expect(
      client.selectPreviewDialogue({
        previewSessionId: 'preview-1',
        expectedRuntimeGeneration: 1,
        dialogueId: '1'
      })
    ).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { status: 'failed', failure: { code: 'staleRuntimeGeneration' } }
    })
  })
})
