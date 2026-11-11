import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { ParsedScene } from '@application/scenes/models/ParsedScene'
import type { SceneSourceFile } from '@application/scenes/models/SceneSourceSnapshot'
import type {
  WebgalPreviewConnection,
  WebgalRuntimeHost,
  WebgalRuntimeHandle
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import { WebgalPreviewRuntimeAdapter } from '@infrastructure/webgal/preview/WebgalPreviewRuntimeAdapter'

type Message = {
  readonly kind?: string
  readonly type?: string
  readonly requestId?: string
  readonly payload?: unknown
}

class MemoryConnection implements WebgalPreviewConnection {
  readonly id = 'preview-test'
  readonly sent: unknown[] = []
  onSend: ((message: Message) => void) | undefined
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(reason?: string) => void>()

  send(message: unknown): void {
    this.sent.push(message)
    this.onSend?.(message as Message)
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
    this.emitClose('closed')
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  emitClose(reason: string): void {
    for (const listener of this.closeListeners) listener(reason)
  }
}

class MemoryHost implements WebgalRuntimeHost {
  private readonly connectionListeners = new Set<(connection: WebgalPreviewConnection) => void>()

  start(): Promise<WebgalRuntimeHandle> {
    throw new Error('测试主机不承载真实运行时')
  }

  onPreviewConnection(listener: (connection: WebgalPreviewConnection) => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  onRequest(): () => void {
    return () => undefined
  }

  getHandle(): WebgalRuntimeHandle | undefined {
    return undefined
  }

  useProjectRoot(): Promise<void> {
    return Promise.resolve()
  }

  previewConnections(): readonly WebgalPreviewConnection[] {
    return []
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }

  connect(connection: WebgalPreviewConnection): void {
    for (const listener of this.connectionListeners) listener(connection)
  }
}

class ListenerSignal {
  aborted = false
  reason: unknown
  readonly listeners = new Set<EventListenerOrEventListenerObject>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'abort' && listener) this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'abort' && listener) this.listeners.delete(listener)
  }

  abort(reason?: unknown): void {
    this.aborted = true
    this.reason = reason
    for (const listener of [...this.listeners]) {
      if (typeof listener === 'function') listener(new Event('abort'))
      else listener.handleEvent(new Event('abort'))
    }
  }
}

function scene(): ParsedScene {
  const text = '旁白:第一句;\n'
  const sourceFile: SceneSourceFile = {
    relativePath: 'game/start.txt',
    kind: 'entry',
    bytes: new TextEncoder().encode(text),
    text,
    size: text.length,
    modifiedAtMs: 0,
    digest: createHash('sha256').update(text).digest('hex')
  }
  return {
    sourceFile,
    contentDigest: sourceFile.digest,
    assets: [],
    subScenes: [],
    diagnostics: [],
    sentences: [
      {
        sequence: 0,
        command: 'say',
        commandRaw: '旁白',
        content: '第一句',
        rawContent: '第一句',
        arguments: [],
        inlineComment: '',
        sourceRange: {
          startOffset: 0,
          endOffset: text.length - 1,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 7
        },
        engineSentenceIndex: 7,
        isLineBreakHolder: false,
        assets: [],
        subScenes: []
      }
    ]
  }
}

function target(source: ParsedScene): {
  sceneFile: string
  sentenceSequence: number
  contentDigest: string
  sourceRange: ParsedScene['sentences'][number]['sourceRange']
} {
  return {
    sceneFile: source.sourceFile.relativePath,
    sentenceSequence: 0,
    contentDigest: source.contentDigest,
    sourceRange: source.sentences[0].sourceRange
  }
}

function registerReady(connection: MemoryConnection, host: MemoryHost): void {
  host.connect(connection)
  connection.emit({
    kind: 'request',
    type: 'session.register-preview',
    requestId: 'register-1',
    payload: {}
  })
  connection.emit({ kind: 'event', type: 'preview.ready.updated', payload: { ready: true } })
}

const adapters: WebgalPreviewRuntimeAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose()
})

describe('WebGAL 预览适配器状态', () => {
  it('使用停止指针定位，并只在同场景快照不早于目标时成功', async () => {
    const host = new MemoryHost()
    const connection = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 100 })
    adapters.push(adapter)
    registerReady(connection, host)
    connection.onSend = (message) => {
      if (message.type !== 'preview.command.sync-scene' || !message.requestId) return
      expect((message.payload as { sentenceId: number }).sentenceId).toBe(8)
      connection.emit({
        kind: 'response',
        type: message.type,
        requestId: message.requestId,
        payload: {}
      })
      connection.emit({
        kind: 'event',
        type: 'stage.snapshot.updated',
        payload: { sceneName: 'start.txt', sentenceId: 8, stageState: { background: 'room.png' } }
      })
    }

    await expect(adapter.syncScene(scene(), target(scene()))).resolves.toMatchObject({
      status: 'located',
      snapshot: { sentenceSequence: 0, stageState: { background: 'room.png' } }
    })
  })

  it('命令超时后移除 Abort 监听器和 pending 请求', async () => {
    const host = new MemoryHost()
    const connection = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 10 })
    adapters.push(adapter)
    registerReady(connection, host)
    const signal = new ListenerSignal()

    await expect(adapter.reloadTemplates(signal as unknown as AbortSignal)).rejects.toMatchObject({
      kind: 'preview-timeout'
    })
    expect(signal.listeners).toHaveLength(0)
  })

  it('调用前已取消时不发送预览命令', async () => {
    const host = new MemoryHost()
    const connection = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 100 })
    adapters.push(adapter)
    registerReady(connection, host)
    const signal = new ListenerSignal()
    signal.abort()

    await expect(adapter.reloadTemplates(signal as unknown as AbortSignal)).rejects.toMatchObject({
      kind: 'preview-cancelled'
    })
    expect(connection.sent).toHaveLength(1)
  })

  it('连接被新预览连接替换时释放旧请求', async () => {
    const host = new MemoryHost()
    const first = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 100 })
    adapters.push(adapter)
    registerReady(first, host)
    const pending = adapter.reloadTemplates()

    host.connect(new MemoryConnection())

    await expect(pending).rejects.toMatchObject({ kind: 'preview-disconnected' })
  })

  it('销毁会话时取消 pending 请求而不是等待超时', async () => {
    const host = new MemoryHost()
    const connection = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 1000 })
    registerReady(connection, host)
    const pending = adapter.reloadTemplates()

    await adapter.dispose()

    await expect(pending).rejects.toMatchObject({ kind: 'preview-cancelled' })
  })

  it('空响应和偏小快照都不能冒充目标句，超时后释放监听器', async () => {
    const host = new MemoryHost()
    const connection = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 10 })
    adapters.push(adapter)
    registerReady(connection, host)
    const signal = new ListenerSignal()
    connection.onSend = (message) => {
      if (message.type !== 'preview.command.sync-scene' || !message.requestId) return
      connection.emit({
        kind: 'response',
        type: message.type,
        requestId: message.requestId,
        payload: {}
      })
      connection.emit({
        kind: 'event',
        type: 'stage.snapshot.updated',
        payload: { sceneName: 'start.txt', sentenceId: 7, stageState: { early: true } }
      })
    }

    const result = await adapter.syncScene(
      scene(),
      target(scene()),
      signal as unknown as AbortSignal
    )
    expect(result).toMatchObject({ status: 'failed', failure: { kind: 'timeout' } })
    expect(signal.listeners).toHaveLength(0)
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 9, stageState: { stale: true } }
    })
    expect(signal.listeners).toHaveLength(0)
  })

  it('预览连接没有出现时返回未就绪', async () => {
    const adapter = new WebgalPreviewRuntimeAdapter({
      host: new MemoryHost(),
      timeoutMs: 10
    })
    adapters.push(adapter)

    await expect(adapter.reloadTemplates()).rejects.toMatchObject({ kind: 'preview-not-ready' })
  })

  it('快速预览超时是无进展，不会当成定位成功', async () => {
    const host = new MemoryHost()
    const connection = new MemoryConnection()
    const adapter = new WebgalPreviewRuntimeAdapter({ host, timeoutMs: 50 })
    adapters.push(adapter)
    registerReady(connection, host)
    connection.onSend = (message) => {
      if (message.type !== 'preview.command.sync-scene' || !message.requestId) return
      connection.emit({
        kind: 'response',
        type: message.type,
        requestId: message.requestId,
        payload: {}
      })
      connection.emit({ kind: 'event', type: 'preview.event.fast-preview-timeout', payload: {} })
    }

    await expect(adapter.syncScene(scene(), target(scene()))).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'no-progress' }
    })
  })
})
