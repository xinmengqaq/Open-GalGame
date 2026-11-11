import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PlayPreviewDialogueRequest } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type {
  PreviewRuntimeEventVO,
  PreviewRuntimeListener
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import { PreviewRuntimeGatewayImpl } from '@infrastructure/scene-preview/PreviewRuntimeGatewayImpl'
import type {
  CandidateScreenFacts,
  CandidateTrustedInputSource
} from '@infrastructure/webgal/compatibility/candidateGameStart'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import {
  MISSING_PREVIEW_CONTROL_COMMANDS,
  WebgalPreviewControlBridge
} from '@infrastructure/webgal/preview/WebgalPreviewControlBridge'
import type {
  SceneTextOverlay,
  WebgalPreviewConnection,
  WebgalRuntimeHost
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'

const roots: string[] = []
const basis: SceneContentBasisVO = {
  digest: 'digest-1',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('固定 WebGAL 预览控制能力', () => {
  it('4.6.5 同步协议没有暂停、继续、草稿、捕获和恢复命令', () => {
    const bridge = new WebgalPreviewControlBridge(new ScriptedPreviewHost())
    expect(bridge.controlCapability()).toEqual({
      status: 'unavailable',
      missingCommands: [...MISSING_PREVIEW_CONTROL_COMMANDS],
      missingEvents: [
        'preview.control.paused',
        'preview.control.resumed',
        'preview.control.replayed',
        'preview.control.draft-applied',
        'preview.control.captured',
        'preview.control.restored'
      ]
    })
    expect(WEBGAL_COMPATIBILITY_PROFILE.previewCommands).not.toEqual(
      expect.arrayContaining([...MISSING_PREVIEW_CONTROL_COMMANDS])
    )
  })

  it('宿主未启动时不能把 iframe 加载冒充成准备成功', async () => {
    const host = new ScriptedPreviewHost()
    const gateway = gatewayFor(host)
    host.markFrameLoaded()

    const prepared = await gateway.prepare(prepareRequest('scene-a'))

    expect(prepared).toMatchObject({
      status: 'failed',
      failure: { code: 'prepareFailed', recovery: 'prepare' }
    })
    expect(host.sentTypes()).not.toEqual(
      expect.arrayContaining(['preview.command.sync-scene', 'preview.command.run-scene-content'])
    )
  })

  it('准备返回真实宿主地址，定位等待注册和就绪后才发送命令', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    const prepared = await gateway.prepare(prepareRequest('scene-a'))

    expect(prepared).toMatchObject({
      status: 'ready',
      stageUrl: 'http://127.0.0.1:9/index.html',
      stage: { phase: 'unknown', position: { kind: 'unknown' } }
    })
    expect(host.sentTypes()).not.toContain('preview.command.sync-scene')

    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 })
    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    expect(host.sentTypes()).not.toContain('preview.command.sync-scene')

    host.markFrameLoaded()
    host.registerAndReady()
    await expect(playing).resolves.toMatchObject({
      status: 'confirmed',
      stage: { phase: 'unknown', position: { kind: 'dialogue', dialogueId: '0' } }
    })
    expect(host.sentTypes()).toContain('session.register-preview')
    expect(host.sentTypes()).toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('当前场景先按可信输入进入游戏，真实游戏快照之前不发送定位', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = new PreviewRuntimeGatewayImpl({
      host,
      bridge: new WebgalPreviewControlBridge(host),
      timeoutMs: 50,
      startupTimeoutMs: 200,
      trustedInput: trustedInputOf(() =>
        host.emitSnapshot({
          sceneName: 'start.txt',
          sentenceId: 1,
          stageState: { showText: '放学后的空地渐渐安静下来。' }
        })
      )
    })
    host.markFrameLoaded()
    host.registerAndReady()
    const prepared = await gateway.prepare(prepareRequest('scene-a'))
    expect(prepared).toMatchObject({
      status: 'ready',
      stageUrl: 'http://127.0.0.1:9/__opengalgame/stage-input/test'
    })
    host.emitSnapshot({
      sceneName: 'start.txt',
      sentenceId: 0,
      stageState: { currentDialogKey: 'initial' }
    })
    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 })

    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    const played = await playing
    expect(played).toMatchObject({
      status: 'confirmed',
      stage: { phase: 'unknown', position: { kind: 'dialogue', dialogueId: '0' } }
    })
    expect(host.sentTypes()).toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('标题画面没有进入游戏时明确失败，不把定位命令发到标题层', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = new PreviewRuntimeGatewayImpl({
      host,
      bridge: new WebgalPreviewControlBridge(host),
      timeoutMs: 50,
      startupTimeoutMs: 20,
      trustedInput: trustedInputOf(() => undefined)
    })
    host.markFrameLoaded()
    host.registerAndReady()
    await gateway.prepare(prepareRequest('scene-a'))
    host.emitSnapshot({
      sceneName: 'start.txt',
      sentenceId: 0,
      stageState: { currentDialogKey: 'initial' }
    })
    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 })

    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ status: 'failed', failure: { code: 'commandTimeout' } })
    expect(host.sentTypes()).not.toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('Electron 读不到画面时不发送定位，超时后才失败', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = new PreviewRuntimeGatewayImpl({
      host,
      bridge: new WebgalPreviewControlBridge(host),
      timeoutMs: 50,
      startupTimeoutMs: 20,
      trustedInput: () => ({
        async readScreen() {
          return null
        },
        async click() {
          return undefined
        },
        async waitForLanguageDismissed() {
          return undefined
        }
      })
    })
    host.markFrameLoaded()
    host.registerAndReady()
    await gateway.prepare(prepareRequest('scene-a'))
    host.emitSnapshot({
      sceneName: 'start.txt',
      sentenceId: 0,
      stageState: { currentDialogKey: 'initial' }
    })
    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 })

    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ status: 'failed', failure: { code: 'commandTimeout' } })
    expect(host.sentTypes()).not.toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('没有真实注册和就绪时定位保持未就绪，不按 iframe 到达或快照冒充', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    await gateway.prepare(prepareRequest('scene-a'))
    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 })

    const played = await gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })

    expect(played).toMatchObject({ status: 'failed', failure: { code: 'runtimeNotReady' } })
    expect(host.sentTypes()).not.toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('准备绑定请求里的工程根，越界或空根拒绝且不报就绪', async () => {
    const host = new ScriptedPreviewHost()
    const gateway = gatewayFor(host)
    const missing = await gateway.prepare({ ...prepareRequest('scene-a'), projectRoot: '' })
    const escaped = await gateway.prepare({
      ...prepareRequest('scene-b'),
      projectRoot: 'project-root/../outside'
    })
    const prepared = await gateway.prepare(prepareRequest('scene-c'))

    expect(missing).toMatchObject({ status: 'failed', failure: { code: 'prepareFailed' } })
    expect(escaped).toMatchObject({ status: 'failed', failure: { code: 'prepareFailed' } })
    expect(prepared).toMatchObject({ status: 'failed', failure: { code: 'prepareFailed' } })
    expect(JSON.stringify(prepared)).not.toContain('stageUrl')
    expect(host.boundRoots).toEqual(['project-root'])
    expect(host.sentTypes()).not.toEqual(
      expect.arrayContaining(['preview.command.sync-scene', 'preview.command.run-scene-content'])
    )
  })

  it('句号小于停止指针时不算选句成功', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    const seen: number[] = []
    host.markFrameLoaded()
    await gateway.prepare(prepareRequest('scene-a'))
    host.registerAndReady()
    gateway.subscribe({ previewSessionId: 'scene-a' }, (event) =>
      seen.push(event.runtimeGeneration)
    )
    host.answerSync({ sceneName: 'start.txt', sentenceId: 0 })

    const played = await gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })

    expect(played).toMatchObject({ status: 'failed', failure: { code: 'locateNotReached' } })
    expect(host.sentPayloads()[0]).toMatchObject({ sentenceId: 1, settleMode: 'normal' })
    expect(host.sentTypes()).not.toContain('preview.command.run-scene-content')
    expect(seen).toEqual([])
  })

  it('同场景快照到达停止指针后确认定位，空响应本身不算成功', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    const seen: number[] = []
    host.markFrameLoaded()
    await gateway.prepare(prepareRequest('scene-a'))
    host.registerAndReady()
    gateway.subscribe({ previewSessionId: 'scene-a' }, (event) =>
      seen.push(event.runtimeGeneration)
    )
    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 }, false)
    const empty = await gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    host.answerSync({ sceneName: 'start.txt', sentenceId: 2 })
    const located = await gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })

    expect(empty).toMatchObject({ status: 'failed', failure: { code: 'locateNotReached' } })
    expect(located).toMatchObject({
      status: 'confirmed',
      stage: { phase: 'unknown', position: { kind: 'dialogue', dialogueId: '0' } }
    })
    expect(seen).toEqual([1])
  })

  it('真实舞台快照作为运行时事件转发，保存换代后旧命令作废', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    await gateway.prepare(prepareRequest('scene-a'))
    host.markFrameLoaded()
    host.registerAndReady()
    const seen: PreviewRuntimeEventVO[] = []
    gateway.subscribe({ previewSessionId: 'scene-a' }, (event) => seen.push(event))

    host.connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1, stageState: {} }
    })
    expect(seen.at(-1)).toMatchObject({
      type: 'stage',
      previewSessionId: 'scene-a',
      runtimeGeneration: 1,
      sequence: 2,
      phase: 'unknown',
      position: { kind: 'dialogue', dialogueId: '0' }
    })

    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    await gateway.rebaseSession({
      previewSessionId: 'scene-a',
      contentBasis: { ...basis, digest: 'digest-2' },
      runtimeGeneration: 2,
      scene: sceneFor('0')
    })
    await expect(playing).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'staleRuntimeGeneration' }
    })

    host.connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1, stageState: {} }
    })
    expect(seen.at(-1)).toMatchObject({
      type: 'stage',
      runtimeGeneration: 2,
      sequence: 1,
      contentBasis: { digest: 'digest-2' }
    })
    await gateway.dispose()
  })

  it('快进超时、分支选项和普通未到达分别返回对应错误', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    host.markFrameLoaded()
    await gateway.prepare(prepareRequest('scene-a'))
    host.registerAndReady()
    const timed = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    host.connection.emit({
      kind: 'response',
      type: 'preview.command.sync-scene',
      requestId: 'late'
    })
    host.connection.emit({ kind: 'event', type: 'preview.event.fast-preview-timeout' })
    await expect(timed).resolves.toMatchObject({ failure: { code: 'commandTimeout' } })

    host.answerSync({ sceneName: 'start.txt', sentenceId: 0, stageState: { choose: ['分支'] } })
    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ failure: { code: 'branchChoiceRequired' } })

    host.answerSync({ sceneName: 'other.txt', sentenceId: 9 })
    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ failure: { code: 'locateNotReached' } })
  })

  it('草稿不写源，旧修订不能覆盖新修订，关闭可重复并释放监听', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-runtime-'))
    roots.push(root)
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const entry = join(root, 'game', 'scene', 'start.txt')
    await writeFile(entry, '旁白:原文;\n', 'utf8')
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = new PreviewRuntimeGatewayImpl({
      host,
      bridge: new WebgalPreviewControlBridge(host),
      timeoutMs: 20
    })
    host.markFrameLoaded()
    await gateway.prepare({
      previewSessionId: 'scene-a',
      contentBasis: basis,
      runtimeGeneration: 1,
      projectRoot: root,
      entryFile: 'game/scene/start.txt',
      scene: sceneFor('0'),
      dialogueId: '0'
    })
    const text = '旁白:新草稿;\n'
    const digest = createHash('sha256').update(text, 'utf8').digest('hex')
    await gateway.setSceneTextOverlay({
      previewSessionId: 'scene-a',
      sceneFileName: 'start.txt',
      editRevision: 2,
      text,
      digest,
      runtimeGeneration: 1
    })
    await expect(
      gateway.setSceneTextOverlay({
        previewSessionId: 'scene-a',
        sceneFileName: 'start.txt',
        editRevision: 1,
        text: '旁白:旧草稿;\n',
        digest,
        runtimeGeneration: 1
      })
    ).rejects.toThrow('场景覆盖不可用')
    expect(await readFile(entry, 'utf8')).toBe('旁白:原文;\n')
    await gateway.release({ previewSessionId: 'scene-a' })
    await gateway.release({ previewSessionId: 'scene-a' })
    await gateway.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('候选舞台与当前场景会话隔离，失效后不复用当前身份', async () => {
    const host = new ScriptedPreviewHost()
    host.installHandle()
    const gateway = gatewayFor(host)
    host.markFrameLoaded()
    await gateway.prepare(prepareRequest('current'))
    host.registerAndReady()
    const candidate = await gateway.prepareCandidate({
      candidateSessionId: 'candidate-1',
      candidateSnapshotId: 'snapshot-1',
      projectRoot: 'candidate-root',
      entryFile: 'game/scene/start.txt'
    })
    await gateway.invalidateCandidate({ candidateSessionId: 'candidate-1' })
    host.answerSync({ sceneName: 'start.txt', sentenceId: 1 })
    const played = await gateway.playDialogue({
      ...prepareRequest('current'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })

    expect(candidate).toMatchObject({
      status: 'failed',
      failure: { code: 'engineCapabilityUnavailable' }
    })
    expect(played).toMatchObject({
      status: 'confirmed',
      stage: { position: { dialogueId: '0' } }
    })
    expect(host.sessionIds()).not.toContain('candidate-1')
    expect(host.sessionIds()).not.toContain('current')
  })
})

function gatewayFor(host: ScriptedPreviewHost): PreviewRuntimeGatewayImpl {
  return new PreviewRuntimeGatewayImpl({
    host,
    bridge: new WebgalPreviewControlBridge(host),
    timeoutMs: 20
  })
}

function sceneFor(dialogueId: string): PlayPreviewDialogueRequest['scene'] {
  const sequence = Number(dialogueId)
  return {
    sourceFile: {
      relativePath: 'game/scene/start.txt',
      kind: 'entry',
      bytes: new Uint8Array(),
      text: '旁白:原文;',
      size: 8,
      modifiedAtMs: 1,
      digest: basis.digest
    },
    contentDigest: basis.digest,
    sentences: [
      {
        sequence,
        command: 'say',
        commandRaw: '旁白:原文;',
        content: '原文',
        rawContent: '原文',
        arguments: [],
        inlineComment: '',
        sourceRange: {
          startOffset: 0,
          endOffset: 8,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 8
        },
        engineSentenceIndex: sequence,
        isLineBreakHolder: false,
        assets: [],
        subScenes: []
      }
    ],
    assets: [],
    subScenes: [],
    diagnostics: []
  }
}

function trustedInputOf(onStart: () => void): CandidateTrustedInputSource {
  return ({ signal }) => {
    if (signal.aborted) return null
    return {
      stagePageUrl: 'http://127.0.0.1:9/__opengalgame/stage-input/test',
      readScreen: async (): Promise<CandidateScreenFacts> => ({
        languageButtons: [],
        titleButtons: [{ text: '开始游戏', x: 1, y: 1, disabled: false }]
      }),
      async click() {
        onStart()
      },
      async activate() {
        onStart()
      },
      async waitForLanguageDismissed() {
        return undefined
      }
    }
  }
}

function prepareRequest(previewSessionId: string): {
  previewSessionId: string
  contentBasis: SceneContentBasisVO
  projectRoot: string
  entryFile: string
  scene: PlayPreviewDialogueRequest['scene']
  dialogueId: string
} {
  return {
    previewSessionId,
    contentBasis: basis,
    runtimeGeneration: 1,
    projectRoot: 'project-root',
    entryFile: 'game/scene/start.txt',
    scene: sceneFor('0'),
    dialogueId: '0'
  }
}

type ControlConfirmation = {
  readonly type: string
  readonly generation: number
  readonly sentenceId: number
  readonly phase: 'paused' | 'playing' | 'completed'
  readonly position?: { readonly kind: 'dialogue'; readonly dialogueId: string }
}

class ScriptedPreviewHost implements WebgalRuntimeHost {
  private readonly listeners = new Set<(connection: WebgalPreviewConnection) => void>()
  private readonly connection = new ScriptedConnection()
  private frameLoaded = false
  private handleInstalled = false
  readonly boundRoots: string[] = []
  markFrameLoaded(): void {
    this.frameLoaded = true
    for (const listener of this.listeners) listener(this.connection)
  }

  installHandle(): void {
    this.handleInstalled = true
  }

  registerAndReady(): void {
    this.connection.emit({
      kind: 'request',
      type: 'session.register-preview',
      requestId: 'register-1',
      payload: {}
    })
    this.connection.emit({
      kind: 'event',
      type: 'preview.ready.updated',
      payload: { ready: true }
    })
  }

  answerSync(
    snapshot: { sceneName: string; sentenceId: number; stoppedAtTarget?: boolean },
    includeSnapshot = true
  ): void {
    this.connection.answerSync(snapshot, includeSnapshot)
  }

  emitSnapshot(snapshot: { sceneName: string; sentenceId: number; stageState?: unknown }): void {
    this.connection.emit({ kind: 'event', type: 'stage.snapshot.updated', payload: snapshot })
  }

  sentTypes(): readonly string[] {
    return this.connection.sent.flatMap((message) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return []
      return typeof message.type === 'string' ? [message.type] : []
    })
  }

  sentPayloads(): readonly unknown[] {
    return this.connection.sent.flatMap((message) => {
      if (!message || typeof message !== 'object' || !('payload' in message)) return []
      const value = message as { type?: unknown; payload?: unknown }
      return value.type === 'preview.command.sync-scene' ? [value.payload] : []
    })
  }
  sessionIds(): readonly string[] {
    return this.connection.sent.flatMap((message) => {
      if (!message || typeof message !== 'object' || !('payload' in message)) return []
      const payload = message.payload
      if (!payload || typeof payload !== 'object' || !('sessionId' in payload)) return []
      return typeof payload.sessionId === 'string' ? [payload.sessionId] : []
    })
  }

  listenerCount(): number {
    return this.connection.listenerCount() + this.listeners.size
  }

  async start(): Promise<WebgalRuntimeHandle> {
    const handle = this.getHandle()
    if (!handle) throw new Error('测试主机不承载真实运行时')
    return handle
  }

  onPreviewConnection(listener: (connection: WebgalPreviewConnection) => void): () => void {
    this.listeners.add(listener)
    if (this.frameLoaded) listener(this.connection)
    return () => this.listeners.delete(listener)
  }

  onRequest(): () => void {
    return () => undefined
  }
  getHandle(): WebgalRuntimeHandle | undefined {
    return this.handleInstalled
      ? {
          baseUrl: 'http://127.0.0.1:9',
          previewUrl: 'ws://127.0.0.1:9/api/webgalsync',
          port: 9,
          build: {
            packageVersion: '4.6.5',
            engineVersion: '4.6.5',
            license: 'MPL-2.0',
            entryFile: 'index.html',
            distFileCount: 1,
            distBytes: 1,
            distDigest: 'test'
          }
        }
      : undefined
  }

  private overlay: SceneTextOverlay | undefined
  useProjectRoot(projectRoot: string): Promise<void> {
    if (projectRoot.trim() === '' || projectRoot.includes('..')) {
      return Promise.reject(new Error('预览工程根不可用'))
    }
    this.boundRoots.push(projectRoot)
    return Promise.resolve()
  }

  setSceneTextOverlay(overlay: SceneTextOverlay): Promise<void> {
    if (
      this.overlay &&
      (this.overlay.previewSessionId !== overlay.previewSessionId ||
        overlay.editRevision < this.overlay.editRevision ||
        overlay.digest !== createHash('sha256').update(overlay.text, 'utf8').digest('hex'))
    ) {
      return Promise.reject(new Error('场景覆盖不可用'))
    }
    this.overlay = overlay
    return Promise.resolve()
  }

  currentSceneTextOverlayRevision(): Promise<number> {
    return Promise.resolve(this.overlay?.editRevision ?? 0)
  }

  clearSceneTextOverlay(): Promise<void> {
    this.overlay = undefined
    return Promise.resolve()
  }

  previewConnections(): readonly WebgalPreviewConnection[] {
    return this.frameLoaded ? [this.connection] : []
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
    this.connection.close()
  }
}

class ScriptedConnection implements WebgalPreviewConnection {
  readonly id = 'scripted-preview'
  readonly sent: unknown[] = []
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(reason?: string) => void>()
  private pendingSnapshot:
    | { sceneName: string; sentenceId: number; stageState?: unknown; stoppedAtTarget?: boolean }
    | undefined

  answerSync(
    snapshot: {
      sceneName: string
      sentenceId: number
      stageState?: unknown
      stoppedAtTarget?: boolean
    },
    includeSnapshot = true
  ): void {
    this.pendingSnapshot = snapshot
    this.includeSnapshot = includeSnapshot
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  send(message: unknown): void {
    this.sent.push(message)
    const snapshot = this.pendingSnapshot
    if (!snapshot || !message || typeof message !== 'object' || !('type' in message)) return
    const command = message as { type?: unknown; requestId?: unknown }
    if (command.type !== 'preview.command.sync-scene') return

    this.emit({
      kind: 'response',
      type: command.type,
      requestId: command.requestId,
      payload: {}
    })
    if (!this.includeSnapshot) return
    this.emit({ kind: 'event', type: 'stage.snapshot.updated', payload: snapshot })
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    for (const listener of this.closeListeners) listener('closed')
    this.messageListeners.clear()
    this.closeListeners.clear()
  }

  listenerCount(): number {
    return this.messageListeners.size + this.closeListeners.size
  }
}
