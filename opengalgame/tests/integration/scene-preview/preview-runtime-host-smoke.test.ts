import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ParsedScene } from '@application/scenes/models/ParsedScene'
import type { SceneTextOverlayRequest } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type { PreviewRuntimeEventVO } from '@application/scene-preview/vo/PreviewRuntimeVO'
import { CandidatePreviewSessionGatewayImpl } from '@infrastructure/scene-preview/CandidatePreviewSessionGatewayImpl'
import { GitCandidatePreviewGatewayImpl } from '@infrastructure/scene-generation/preview/GitCandidatePreviewGatewayImpl'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { writeCandidateRevision } from '@infrastructure/git/objects/writeCandidateRevision'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { PreviewRuntimeGatewayImpl } from '@infrastructure/scene-preview/PreviewRuntimeGatewayImpl'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import {
  MISSING_PREVIEW_CONTROL_COMMANDS,
  WebgalPreviewControlBridge
} from '@infrastructure/webgal/preview/WebgalPreviewControlBridge'
import {
  WebgalRuntimeHostImpl,
  type WebgalPreviewConnection
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import { chromium, type Browser } from 'playwright'
import { WebSocket } from 'ws'

const roots: string[] = []
const dialogueText = '放学后的空地渐渐安静下来。澪一直没有把手里的画稿递出去。'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('隔离 WebGAL 运行时宿主', () => {
  it('真实承载已启动时只返回宿主地址，没有注册和就绪时定位失败且不写源', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-runtime-host-'))
    roots.push(root)
    const entry = join(root, 'game', 'scene', 'start.txt')
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const source = '旁白:原文;\n'
    await writeFile(entry, source, 'utf8')
    await mkdir(join(root, '.opengalgame'), { recursive: true })
    await writeFile(
      join(root, '.opengalgame/manifest.json'),
      JSON.stringify({
        formatVersion: 2,
        projectId: 'project-host',
        operationId: 'op-register'
      })
    )
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const bridge = new WebgalPreviewControlBridge(host)
    const gateway = new PreviewRuntimeGatewayImpl({ host, bridge, timeoutMs: 30 })
    const handle = await host.start()
    try {
      const index = await fetch(`${handle.baseUrl}/index.html`)
      const script = await fetch(`${handle.baseUrl}/game/scene/start.txt`)
      expect(index.status).toBe(200)
      expect(await script.text()).toBe(source)
      expect(bridge.controlCapability().status).toBe('unavailable')

      const prepared = await gateway.prepare({
        previewSessionId: 'scene-a',
        contentBasis: {
          digest: 'digest-1',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 1,
        projectRoot: root,
        entryFile: 'game/scene/start.txt',
        scene: hostScene(),
        dialogueId: '0'
      })
      const played = await gateway.playDialogue({
        previewSessionId: 'scene-a',
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: hostScene()
      })
      await expect(
        gateway.setSceneTextOverlay({
          previewSessionId: 'scene-a',
          sceneFileName: 'start.txt',
          editRevision: 1,
          text: '草稿',
          digest: '0'.repeat(64),
          runtimeGeneration: 1
        })
      ).rejects.toThrow('场景覆盖不可用')

      expect(prepared).toMatchObject({
        status: 'ready',
        stage: { phase: 'unknown', position: { kind: 'unknown' } },
        stageUrl: `${handle.baseUrl}/index.html`
      })
      expect(played).toMatchObject({
        status: 'failed',
        failure: { code: 'runtimeNotReady' }
      })
      expect(await readFile(entry, 'utf8')).toBe(source)
      expect(WEBGAL_COMPATIBILITY_PROFILE.previewProtocol).toBe('webgal-editor-preview-sync.v1')
      await gateway.release({ previewSessionId: 'scene-a' })
      await gateway.release({ previewSessionId: 'scene-a' })
    } finally {
      bridge.dispose()
      await host.dispose()
    }
  })

  it('正式宿主只映射已绑定工程根，越界和无根拒绝，关闭后不再接收迟到事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-formal-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'opengalgame-preview-formal-outside-'))
    roots.push(root, outside)
    const projectRoot = join(root, 'project')
    const userDirectory = join(root, 'user')
    await mkdir(join(projectRoot, 'game', 'scene'), { recursive: true })
    await mkdir(userDirectory, { recursive: true })
    await writeFile(join(projectRoot, 'game', 'scene', 'start.txt'), '旁白:工程;\n', 'utf8')
    const audioKey = encodeStorageKey('1f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b')
    const audioBytes = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x01, 0x02, 0xff)
    await mkdir(join(projectRoot, 'assets', audioKey), { recursive: true })
    await writeFile(join(projectRoot, 'assets', audioKey, 'duck.ogg'), audioBytes)
    await writeFile(join(userDirectory, 'secret.txt'), '用户目录秘密', 'utf8')
    await writeFile(join(outside, 'secret.txt'), '区外秘密', 'utf8')
    await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
    await writeFile(
      join(projectRoot, '.opengalgame/project.json'),
      JSON.stringify({
        id: 'project-formal',
        name: '正式预览',
        synopsis: ''
      })
    )
    await writeFile(
      join(projectRoot, '.opengalgame/manifest.json'),
      JSON.stringify({
        formatVersion: 2,
        projectId: 'project-formal',
        operationId: 'op-register'
      })
    )
    await mkdir(join(projectRoot, '.opengalgame/canvases', encodeStorageKey('scene-formal')), {
      recursive: true
    })
    await writeFile(
      join(projectRoot, '.opengalgame/canvases', encodeStorageKey('scene-formal'), 'canvas.json'),
      '{}'
    )
    await writeProjectRegistrations(userDirectory, [
      { id: 'project-formal', directory: projectRoot, operationId: 'op-register' }
    ])
    await symlink(outside, join(projectRoot, 'game', 'linked'), 'junction')
    const located = await new RegisteredSceneLocationGatewayImpl(
      userDirectory
    ).resolveRegisteredScene({
      projectId: 'project-formal',
      sceneId: 'scene-formal'
    })
    expect(located.projectRoot).toBe(projectRoot)
    const host = new WebgalRuntimeHostImpl({
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const bridge = new WebgalPreviewControlBridge(host)
    const gateway = new PreviewRuntimeGatewayImpl({ host, bridge, timeoutMs: 30 })
    const handle = await host.start()
    const events: string[] = []
    try {
      expect((await fetch(`${handle.baseUrl}/game/scene/start.txt`)).status).toBe(404)
      await expect(host.useProjectRoot(userDirectory)).rejects.toThrow('预览工程根不可用')
      await expect(host.useProjectRoot(outside)).rejects.toThrow('预览工程根不可用')
      const linked = await host.useProjectRoot(join(projectRoot, 'game', 'linked')).then(
        () => undefined,
        (error: unknown) => error
      )
      expect(linked).toBeInstanceOf(Error)
      expect(String(linked)).not.toContain(outside)
      expect(String(linked)).not.toContain(userDirectory)
      expect((await fetch(`${handle.baseUrl}/game/scene/start.txt`)).status).toBe(404)

      await host.useProjectRoot(projectRoot)
      const script = await fetch(`${handle.baseUrl}/game/scene/start.txt`)
      expect(await script.text()).toBe('旁白:工程;\n')
      for (const directory of ['bgm', 'vocal']) {
        const audio = await fetch(`${handle.baseUrl}/game/${directory}/${audioKey}/duck.ogg`)
        expect(audio.status).toBe(200)
        expect(new Uint8Array(await audio.arrayBuffer())).toEqual(audioBytes)
      }
      await expect(
        readFile(join(projectRoot, 'game', 'bgm', audioKey, 'duck.ogg'))
      ).rejects.toThrow()
      await expect(
        readFile(join(projectRoot, 'game', 'vocal', audioKey, 'duck.ogg'))
      ).rejects.toThrow()
      expect(
        new Uint8Array(await readFile(join(projectRoot, 'assets', audioKey, 'duck.ogg')))
      ).toEqual(audioBytes)
      const userFile = await fetch(`${handle.baseUrl}/secret.txt`)
      const outsideFile = await fetch(`${handle.baseUrl}/game/../secret.txt`)
      expect(userFile.status).not.toBe(200)
      expect(outsideFile.status).not.toBe(200)

      const prepared = await gateway.prepare({
        previewSessionId: 'formal-a',
        contentBasis: {
          digest: 'digest-formal',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 1,
        projectRoot,
        entryFile: 'start.txt',
        scene: hostScene(),
        dialogueId: '0'
      })
      expect(prepared).toMatchObject({
        status: 'ready',
        stage: { phase: 'unknown', position: { kind: 'unknown' } },
        stageUrl: `${handle.baseUrl}/index.html`
      })
      expect(JSON.stringify(prepared)).not.toContain(projectRoot)
      gateway.subscribe({ previewSessionId: 'formal-a' }, () => events.push('late'))
      const closed = gateway.release({ previewSessionId: 'formal-a' })
      await closed
      gateway.subscribe({ previewSessionId: 'formal-a' }, () => events.push('after-close'))
      expect(events).toEqual([])
      expect((await fetch(`${handle.baseUrl}/secret.txt`)).status).not.toBe(200)
    } finally {
      bridge.dispose()
      await host.dispose()
    }
  })

  it('真实引擎注册后只确认预览就绪和舞台快照，拒绝暂停、继续、重播、草稿、捕获和恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-runtime-live-'))
    roots.push(root)
    const entry = join(root, 'game', 'scene', 'start.txt')
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const source = '旁白:原文;\n'
    await writeFile(entry, source, 'utf8')
    await mkdir(join(root, '.opengalgame'), { recursive: true })
    await writeFile(
      join(root, '.opengalgame/manifest.json'),
      JSON.stringify({
        formatVersion: 2,
        projectId: 'project-live',
        operationId: 'op-register'
      })
    )
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const bridge = new WebgalPreviewControlBridge(host)
    const gateway = new PreviewRuntimeGatewayImpl({
      host,
      bridge,
      timeoutMs: 12_000
    })
    const messages: ProtocolMessage[] = []
    const waiters = new Set<(items: readonly ProtocolMessage[]) => void>()
    let connection: WebgalPreviewConnection | undefined
    const removeConnection = host.onPreviewConnection((next) => {
      connection = next
      next.onMessage((message) => {
        if (!message || typeof message !== 'object') return
        messages.push(message as ProtocolMessage)
        for (const waiter of waiters) waiter(messages)
      })
    })
    const untilMessage = (ready: (items: readonly ProtocolMessage[]) => boolean): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        waiters.delete(notify)
        reject(new Error(`引擎协议没有出现预期消息：${JSON.stringify(messages)}`))
      }, 12_000)
      const notify = (items: readonly ProtocolMessage[]): void => {
        if (!ready(items)) return
        clearTimeout(timer)
        waiters.delete(notify)
        resolve()
      }
      waiters.add(notify)
      notify(messages)
      return promise
    }
    let browser: Browser | undefined
    const handle = await host.start()
    try {
      const prepared = await gateway.prepare({
        previewSessionId: 'scene-live',
        contentBasis: {
          digest: 'digest-live',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 1,
        projectRoot: root,
        entryFile: 'game/scene/start.txt',
        scene: hostScene(),
        dialogueId: '0'
      })
      expect(prepared).toMatchObject({
        status: 'ready',
        stage: { phase: 'unknown', position: { kind: 'unknown' } },
        stageUrl: `${handle.baseUrl}/index.html`
      })
      expect(messages).toEqual([])
      expect(bridge.controlCapability().status).toBe('unavailable')

      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      await page.goto(`${handle.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' })
      await untilMessage(
        (items) =>
          items.some(
            (item) => item.type === 'preview.ready.updated' && item.payload?.ready === true
          ) && items.some((item) => item.type === 'stage.snapshot.updated')
      )
      const snapshot = messages.find((item) => item.type === 'stage.snapshot.updated')
      expect(typeof snapshot?.payload?.sceneName).toBe('string')
      expect(typeof snapshot?.payload?.sentenceId).toBe('number')
      expect(snapshot?.payload?.stageState).toEqual(expect.any(Object))
      expect(snapshot?.payload?.stageState).not.toHaveProperty('phase')

      const rejectedCommands = [...MISSING_PREVIEW_CONTROL_COMMANDS, 'preview.command.replay']
      for (const type of rejectedCommands) {
        connection?.send({
          kind: 'request',
          type,
          requestId: `reject-${type}`,
          payload: { dialogueId: '0', text: '草稿不应出现' }
        })
      }
      await untilMessage((items) =>
        rejectedCommands.every((type) =>
          items.some(
            (item) =>
              item.kind === 'error' &&
              item.type === type &&
              item.requestId === `reject-${type}` &&
              item.error?.code === 'unsupported-request-type' &&
              item.error.message === '当前预览运行时不支持该请求类型'
          )
        )
      )

      expect(handle.build.packageVersion).toBe('4.6.5')
      expect(handle.build.engineVersion).toBe('4.6.5')
      expect(messages.filter((item) => item.type?.startsWith('preview.control.'))).toEqual([])
      expect(await page.locator('body').innerText()).not.toContain('草稿不应出现')
      expect(await readFile(entry, 'utf8')).toBe(source)
      await gateway.release({ previewSessionId: 'scene-live' })
    } finally {
      removeConnection()
      bridge.dispose()
      await browser?.close()
      await host.dispose()
    }
  }, 30_000)

  it('真实页面按停止指针定位，空响应单独出现不算成功', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-locate-'))
    roots.push(root)
    const entry = join(root, 'game', 'scene', 'start.txt')
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    await writeFile(entry, '旁白:第一句;\n旁白:定位目标句;\n', 'utf8')
    await mkdir(join(root, '.opengalgame'), { recursive: true })
    await writeFile(
      join(root, '.opengalgame/manifest.json'),
      JSON.stringify({ formatVersion: 2, projectId: 'project-locate', operationId: 'op-register' })
    )
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const bridge = new WebgalPreviewControlBridge(host)
    const gateway = new PreviewRuntimeGatewayImpl({ host, bridge, timeoutMs: 12_000 })
    const messages: ProtocolMessage[] = []
    const sent: unknown[] = []
    const waiters = new Set<(items: readonly ProtocolMessage[]) => void>()
    let connection: WebgalPreviewConnection | undefined
    const removeConnection = host.onPreviewConnection((next) => {
      connection = next
      next.onMessage((message) => {
        if (!message || typeof message !== 'object') return
        messages.push(message as ProtocolMessage)
        for (const waiter of waiters) waiter(messages)
      })
    })
    const untilMessage = (ready: (items: readonly ProtocolMessage[]) => boolean): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        waiters.delete(notify)
        reject(new Error(`引擎协议没有出现预期消息：${JSON.stringify(messages)}`))
      }, 12_000)
      const notify = (items: readonly ProtocolMessage[]): void => {
        if (!ready(items)) return
        clearTimeout(timer)
        waiters.delete(notify)
        resolve()
      }
      waiters.add(notify)
      notify(messages)
      return promise
    }
    let browser: Browser | undefined
    const handle = await host.start()
    try {
      const scene = locateScene()
      const prepared = await gateway.prepare({
        previewSessionId: 'locate',
        contentBasis: {
          digest: 'digest-locate',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 1,
        projectRoot: root,
        entryFile: 'game/scene/start.txt',
        scene,
        dialogueId: '1'
      })
      expect(prepared.status).toBe('ready')
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      await page.goto(`${handle.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' })
      await untilMessage(
        (items) =>
          items.some(
            (item) => item.type === 'preview.ready.updated' && item.payload?.ready === true
          ) && items.some((item) => item.type === 'stage.snapshot.updated')
      )
      if (!connection) throw new Error('预览连接没有出现')
      const send = connection.send.bind(connection)
      connection.send = (message) => {
        sent.push(message)
        send(message)
      }
      connection.send({
        kind: 'response',
        type: 'preview.command.sync-scene',
        requestId: 'empty-only',
        payload: {}
      })
      const before = messages.length
      const located = await gateway.playDialogue({
        previewSessionId: 'locate',
        expectedRuntimeGeneration: 1,
        dialogueId: '1',
        scene
      })
      expect(located).toMatchObject({
        status: 'confirmed',
        stage: { phase: 'unknown', position: { kind: 'dialogue', dialogueId: '1' } }
      })
      const snapshot = [...messages]
        .slice(before)
        .reverse()
        .find((item) => item.type === 'stage.snapshot.updated')
      expect(snapshot?.payload?.sentenceId).toBeGreaterThanOrEqual(2)
      expect(snapshot?.payload?.stageState?.showText).toBe('定位目标句')
      expect(await readFile(entry, 'utf8')).toContain('定位目标句')
    } finally {
      removeConnection()
      bridge.dispose()
      await browser?.close()
      await host.dispose()
    }
  }, 30_000)

  it('真实页面由宿主扩展直接进入剧情，不发送定位命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-candidate-stage-'))
    roots.push(root)
    const projectRoot = join(root, 'project')
    await mkdir(join(projectRoot, 'game', 'scene'), { recursive: true })
    await writeFile(
      join(projectRoot, 'game', 'scene', 'start.txt'),
      `旁白:${dialogueText}\n`,
      'utf8'
    )
    const gitDir = join(root, 'state', 'revisions.git')
    const { revisionId } = await writeCandidateRevision(gitDir, [
      {
        relativePath: 'game/scene/start.txt',
        action: 'upsert',
        sourceFile: join(projectRoot, 'game', 'scene', 'start.txt')
      }
    ])
    const files = new AiProjectFileSystemImpl(join(root, 'state'))
    let now = Date.now()
    const gateway = new GitCandidatePreviewGatewayImpl(
      files,
      join(root, 'state', 'ai'),
      () => now,
      undefined,
      12_000
    )
    const workspace = files.locateWorkspace({
      projectId: 'project-candidate',
      sceneId: 'scene-candidate',
      operationId: 'operation-candidate',
      threadId: 'thread-candidate'
    })
    await mkdir(dirname(workspace.revisionGitDir), { recursive: true })
    await cp(gitDir, workspace.revisionGitDir, { recursive: true })
    const events: CandidateEvent[] = []
    const stop = gateway.subscribeCandidatePreviewEvents((event) => {
      events.push(event)
    })
    let browser: Browser | undefined
    let opened:
      { preview: { previewSessionId: string; url: string }; stage: Promise<void> } | undefined
    try {
      opened = await gateway.openPublishedCandidatePreview(
        {
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          operationId: 'operation-candidate',
          threadId: 'thread-candidate',
          branchId: 'branch-candidate',
          checkpointId: 'checkpoint-candidate',
          candidateSnapshotId: revisionId
        },
        { entryFile: 'game/scene/start.txt', sceneName: 'start' }
      )
      expect(events).toEqual([])
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      const received: string[] = []
      page.on('websocket', (socket) => {
        socket.on('framereceived', (frame) => {
          received.push(
            typeof frame.payload === 'string' ? frame.payload : frame.payload.toString()
          )
        })
      })
      const loaded = page.goto(opened.preview.url, { waitUntil: 'domcontentloaded' })
      expect(events).toEqual([])
      await loaded
      await opened.stage
      expect(events).toEqual([
        expect.objectContaining({
          type: 'ready',
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          previewSessionId: opened.preview.previewSessionId,
          candidateSnapshotId: revisionId,
          message: '游戏已就绪'
        })
      ])
      expect(received.join('\n')).not.toContain('preview.command.sync-scene')
      expect(received.join('\n')).not.toContain('preview.command.run-scene-content')
      expect(JSON.stringify(events)).not.toContain(projectRoot)
      expect(JSON.stringify(events)).not.toContain('start.txt')
      expect(gateway.readCandidatePreviewEvent(opened.preview.previewSessionId)).toMatchObject({
        type: 'ready',
        sequence: 1,
        previewSessionId: opened.preview.previewSessionId
      })

      const timedOut = new GitCandidatePreviewGatewayImpl(
        files,
        join(root, 'state', 'ai'),
        Date.now,
        undefined,
        300
      )
      const stopTimeout = timedOut.subscribeCandidatePreviewEvents((event) => {
        events.push(event)
      })
      const failed = await timedOut.openPublishedCandidatePreview(
        {
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          operationId: 'operation-timeout',
          threadId: 'thread-candidate',
          branchId: 'branch-candidate',
          checkpointId: 'checkpoint-candidate',
          candidateSnapshotId: revisionId
        },
        { entryFile: 'game/scene/start.txt', sceneName: 'start' }
      )
      await failed.stage
      stopTimeout()
      expect(events.at(-1)).toMatchObject({
        type: 'stageFailed',
        previewSessionId: failed.preview.previewSessionId,
        candidateSnapshotId: revisionId,
        message: '游戏加载超时'
      })
      expect(JSON.stringify(events)).not.toContain(projectRoot)
      await timedOut.close()

      await browser?.close()
      browser = undefined
      await gateway.closeCandidatePreview({
        projectId: 'project-candidate',
        sceneId: 'scene-candidate',
        operationId: 'operation-candidate',
        threadId: 'thread-candidate',
        branchId: 'branch-candidate',
        previewSessionId: opened.preview.previewSessionId
      })
      expect(events.at(-1)).toMatchObject({
        type: 'invalidated',
        sequence: 2,
        previewSessionId: opened.preview.previewSessionId,
        candidateSnapshotId: revisionId
      })
      expect(gateway.readCandidatePreviewEvent(opened.preview.previewSessionId)).toMatchObject({
        type: 'invalidated',
        sequence: 2
      })
      expect(events.filter((event) => event.type === 'ready')).toHaveLength(1)
      const sessions = new CandidatePreviewSessionGatewayImpl(gateway, Date.now)
      await expect(
        sessions.resolveCandidatePreviewSession({
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          previewSessionId: opened.preview.previewSessionId
        })
      ).resolves.toEqual({ status: 'rejected', reason: 'missing' })
      const expired = await gateway.openPublishedCandidatePreview(
        {
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          operationId: 'operation-expired',
          threadId: 'thread-candidate',
          branchId: 'branch-candidate',
          checkpointId: 'checkpoint-candidate',
          candidateSnapshotId: revisionId
        },
        { entryFile: 'game/scene/start.txt', sceneName: 'start' }
      )
      now += 15 * 60 * 1000 + 1
      const expiredSessions = new CandidatePreviewSessionGatewayImpl(gateway, () => now)
      await expect(
        expiredSessions.resolveCandidatePreviewSession({
          projectId: 'project-candidate',
          sceneId: 'scene-candidate',
          previewSessionId: expired.preview.previewSessionId
        })
      ).resolves.toEqual({ status: 'rejected', reason: 'expired' })
      await expect(
        expiredSessions.resolveCandidatePreviewSession({
          projectId: 'other-project',
          sceneId: 'scene-candidate',
          previewSessionId: expired.preview.previewSessionId
        })
      ).resolves.toEqual({ status: 'rejected', reason: 'mismatch' })
      await gateway.closeCandidatePreview({
        projectId: 'project-candidate',
        sceneId: 'scene-candidate',
        operationId: 'operation-expired',
        threadId: 'thread-candidate',
        branchId: 'branch-candidate',
        previewSessionId: expired.preview.previewSessionId
      })
    } finally {
      stop()
      await browser?.close()
      if (opened) {
        await gateway
          .closeCandidatePreview({
            projectId: 'project-candidate',
            sceneId: 'scene-candidate',
            operationId: 'operation-candidate',
            threadId: 'thread-candidate',
            branchId: 'branch-candidate',
            previewSessionId: opened.preview.previewSessionId
          })
          .catch(() => undefined)
      }
      await gateway.close()
    }
  }, 45_000)

  it('真实宿主覆盖层按会话代次接受、读取和清除，准备换代与重复释放保持幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-overlay-'))
    roots.push(root)
    const entry = join(root, 'game', 'scene', 'start.txt')
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const source = '旁白:原文;\n'
    await writeFile(entry, source, 'utf8')
    await mkdir(join(root, '.opengalgame'), { recursive: true })
    await writeFile(
      join(root, '.opengalgame/manifest.json'),
      JSON.stringify({
        formatVersion: 2,
        projectId: 'project-overlay',
        operationId: 'op-register'
      })
    )
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const bridge = new WebgalPreviewControlBridge(host)
    const gateway = new PreviewRuntimeGatewayImpl({ host, bridge, timeoutMs: 30 })
    const handle = await host.start()
    const overlay = (
      runtimeGeneration: number,
      editRevision: number
    ): SceneTextOverlayRequest => {
      const text = `旁白:草稿${editRevision};\n`
      return {
        previewSessionId: 'overlay-a',
        sceneFileName: 'start.txt',
        editRevision,
        text,
        digest: createHash('sha256').update(text, 'utf8').digest('hex'),
        runtimeGeneration
      }
    }
    try {
      const prepared = await gateway.prepare({
        previewSessionId: 'overlay-a',
        contentBasis: {
          digest: 'digest-1',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 1,
        projectRoot: root,
        entryFile: 'game/scene/start.txt',
        scene: hostScene(),
        dialogueId: '0'
      })
      expect(prepared).toMatchObject({ status: 'ready', stage: { runtimeGeneration: 1 } })

      await gateway.setSceneTextOverlay(overlay(1, 1))
      await expect(
        gateway.currentSceneTextOverlayRevision({
          previewSessionId: 'overlay-a',
          runtimeGeneration: 1
        })
      ).resolves.toBe(1)

      await gateway.clearSceneTextOverlay({
        previewSessionId: 'overlay-a',
        runtimeGeneration: 2
      })
      await expect(
        gateway.currentSceneTextOverlayRevision({
          previewSessionId: 'overlay-a',
          runtimeGeneration: 1
        })
      ).resolves.toBe(1)
      await gateway.clearSceneTextOverlay({
        previewSessionId: 'overlay-a',
        runtimeGeneration: 1
      })
      await expect(
        gateway.currentSceneTextOverlayRevision({
          previewSessionId: 'overlay-a',
          runtimeGeneration: 1
        })
      ).resolves.toBe(0)

      await gateway.setSceneTextOverlay(overlay(1, 2))
      await gateway.prepare({
        previewSessionId: 'overlay-a',
        contentBasis: {
          digest: 'digest-2',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 2,
        projectRoot: root,
        entryFile: 'game/scene/start.txt',
        scene: hostScene(),
        dialogueId: '0'
      })
      await expect(
        gateway.currentSceneTextOverlayRevision({
          previewSessionId: 'overlay-a',
          runtimeGeneration: 2
        })
      ).resolves.toBe(0)
      await expect(
        gateway.playDialogue({
          previewSessionId: 'overlay-a',
          expectedRuntimeGeneration: 1,
          dialogueId: '0',
          scene: hostScene()
        })
      ).resolves.toMatchObject({ status: 'failed', failure: { code: 'staleRuntimeGeneration' } })

      await gateway.release({ previewSessionId: 'overlay-a' })
      await gateway.release({ previewSessionId: 'overlay-a' })
      await expect(gateway.setSceneTextOverlay(overlay(2, 3))).rejects.toThrow('场景覆盖不可用')
      expect(await readFile(entry, 'utf8')).toBe(source)
    } finally {
      await gateway.dispose()
      bridge.dispose()
      await host.dispose()
    }
  })

  it('真实宿主连接按注册与就绪过滤事件，定位接受响应后的同场景快照，释放后迟到快照不再转发', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-preview-ws-'))
    roots.push(root)
    const entry = join(root, 'game', 'scene', 'start.txt')
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const source = '旁白:原文;\n'
    await writeFile(entry, source, 'utf8')
    await mkdir(join(root, '.opengalgame'), { recursive: true })
    await writeFile(
      join(root, '.opengalgame/manifest.json'),
      JSON.stringify({
        formatVersion: 2,
        projectId: 'project-ws',
        operationId: 'op-register'
      })
    )
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const bridge = new WebgalPreviewControlBridge(host)
    const gateway = new PreviewRuntimeGatewayImpl({ host, bridge, timeoutMs: 2_000 })
    const handle = await host.start()
    const messages: ProtocolMessage[] = []
    const waiters = new Set<() => void>()
    const notify = (): void => {
      for (const waiter of [...waiters]) waiter()
    }
    const until = (ready: (items: readonly ProtocolMessage[]) => boolean): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`引擎协议没有出现预期消息：${JSON.stringify(messages)}`))
      }, 2_000)
      const check = (): void => {
        if (!ready(messages)) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve()
      }
      waiters.add(check)
      check()
      return promise
    }
    let socket: WebSocket | undefined
    try {
      await gateway.prepare({
        previewSessionId: 'ws-a',
        contentBasis: {
          digest: 'digest-ws-1',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 1,
        projectRoot: root,
        entryFile: 'game/scene/start.txt',
        scene: hostScene(),
        dialogueId: '0'
      })
      const events: PreviewRuntimeEventVO[] = []
      gateway.subscribe({ previewSessionId: 'ws-a' }, (event) => {
        events.push(event)
        notify()
      })
      const preview = await connectPreview(handle.previewUrl, messages, notify)
      socket = preview
      preview.send(
        JSON.stringify({
          kind: 'request',
          type: 'session.register-preview',
          requestId: 'register-ws',
          payload: {}
        })
      )
      await until((items) =>
        items.some(
          (item) =>
            item.kind === 'response' &&
            item.type === 'session.register-preview' &&
            item.requestId === 'register-ws'
        )
      )
      preview.send(
        JSON.stringify({
          kind: 'event',
          type: 'preview.ready.updated',
          payload: { ready: true }
        })
      )
      preview.send(
        JSON.stringify({
          kind: 'event',
          type: 'stage.snapshot.updated',
          payload: { sceneName: 'start.txt', sentenceId: 1, stageState: {} }
        })
      )
      await until(() => events.some((event) => event.type === 'stage'))
      expect(events.at(-1)).toMatchObject({
        type: 'stage',
        previewSessionId: 'ws-a',
        runtimeGeneration: 1,
        sequence: 2,
        position: { kind: 'dialogue', dialogueId: '0' }
      })

      const playing = gateway.playDialogue({
        previewSessionId: 'ws-a',
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: hostScene()
      })
      await until((items) =>
        items.some(
          (item) => item.kind === 'request' && item.type === 'preview.command.sync-scene'
        )
      )
      const request = [...messages]
        .reverse()
        .find((item) => item.kind === 'request' && item.type === 'preview.command.sync-scene')
      if (!request?.requestId) throw new Error('定位请求缺少 requestId')
      preview.send(
        JSON.stringify({
          kind: 'response',
          type: 'preview.command.sync-scene',
          requestId: request.requestId,
          payload: {}
        })
      )
      preview.send(
        JSON.stringify({
          kind: 'event',
          type: 'stage.snapshot.updated',
          payload: { sceneName: 'start.txt', sentenceId: 1, stageState: {} }
        })
      )
      await expect(playing).resolves.toMatchObject({ status: 'confirmed' })

      await gateway.rebaseSession({
        previewSessionId: 'ws-a',
        contentBasis: {
          digest: 'digest-ws-2',
          parserVersion: '4.6.5',
          engineVersion: handle.build.engineVersion
        },
        runtimeGeneration: 2,
        scene: hostScene()
      })
      preview.send(
        JSON.stringify({
          kind: 'event',
          type: 'stage.snapshot.updated',
          payload: { sceneName: 'start.txt', sentenceId: 1, stageState: {} }
        })
      )
      await until(() =>
        events.some((event) => event.type === 'stage' && event.runtimeGeneration === 2)
      )
      expect(events.at(-1)).toMatchObject({
        type: 'stage',
        previewSessionId: 'ws-a',
        runtimeGeneration: 2,
        sequence: 1,
        position: { kind: 'dialogue', dialogueId: '0' }
      })
      await expect(
        gateway.playDialogue({
          previewSessionId: 'ws-a',
          expectedRuntimeGeneration: 1,
          dialogueId: '0',
          scene: hostScene()
        })
      ).resolves.toMatchObject({ status: 'failed', failure: { code: 'staleRuntimeGeneration' } })

      await gateway.release({ previewSessionId: 'ws-a' })
      await gateway.release({ previewSessionId: 'ws-a' })
      const forwarded = events.length
      preview.send(
        JSON.stringify({
          kind: 'event',
          type: 'stage.snapshot.updated',
          payload: { sceneName: 'start.txt', sentenceId: 1, stageState: {} }
        })
      )
      preview.send(
        JSON.stringify({
          kind: 'request',
          type: 'session.register-preview',
          requestId: 'register-after-release',
          payload: {}
        })
      )
      await until((items) =>
        items.some(
          (item) =>
            item.kind === 'response' &&
            item.type === 'session.register-preview' &&
            item.requestId === 'register-after-release'
        )
      )
      expect(events).toHaveLength(forwarded)
      expect(await readFile(entry, 'utf8')).toBe(source)
    } finally {
      socket?.close()
      await gateway.dispose()
      bridge.dispose()
      await host.dispose()
    }
  }, 10_000)
})

type ProtocolMessage = {
  readonly kind?: string
  readonly type?: string
  readonly requestId?: string
  readonly payload?: {
    readonly ready?: boolean
    readonly sceneName?: string
    readonly sentenceId?: number
    readonly settleMode?: string
    readonly stageState?: unknown
  }
  readonly error?: { readonly code?: string; readonly message?: string }
}

type CandidateEvent = {
  readonly type: 'ready' | 'stageFailed' | 'invalidated'
  readonly sequence: number
  readonly projectId: string
  readonly sceneId: string
  readonly previewSessionId: string
  readonly candidateSnapshotId: string
  readonly message?: string
}

function connectPreview(
  previewUrl: string,
  received: ProtocolMessage[],
  notify: () => void
): Promise<WebSocket> {
  const socket = new WebSocket(previewUrl, [WEBGAL_COMPATIBILITY_PROFILE.previewProtocol])
  socket.on('message', (data) => {
    try {
      received.push(JSON.parse(data.toString()))
      notify()
    } catch {
    }
  })
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>()
  socket.once('open', () => resolve(socket))
  socket.once('error', reject)
  return promise
}

function locateScene(): ParsedScene {
  const sentence = (sequence: number, content: string): ParsedScene['sentences'][number] => ({
    sequence,
    command: 'say',
    commandRaw: `旁白:${content};`,
    content,
    rawContent: content,
    arguments: [],
    inlineComment: '',
    sourceRange: {
      startOffset: 0,
      endOffset: content.length,
      startLine: sequence,
      startColumn: 0,
      endLine: sequence,
      endColumn: content.length
    },
    engineSentenceIndex: sequence,
    isLineBreakHolder: false,
    assets: [],
    subScenes: []
  })
  return {
    sourceFile: {
      relativePath: 'game/scene/start.txt',
      kind: 'entry',
      bytes: new Uint8Array(),
      text: '旁白:第一句;\n旁白:定位目标句;',
      size: 20,
      modifiedAtMs: 1,
      digest: 'digest-locate'
    },
    contentDigest: 'digest-locate',
    sentences: [sentence(0, '第一句'), sentence(1, '定位目标句')],
    assets: [],
    subScenes: [],
    diagnostics: []
  }
}

function hostScene(): ParsedScene {
  return {
    sourceFile: {
      relativePath: 'game/scene/start.txt',
      kind: 'entry',
      bytes: new Uint8Array(),
      text: '旁白:原文;',
      size: 8,
      modifiedAtMs: 1,
      digest: 'digest-1'
    },
    contentDigest: 'digest-1',
    sentences: [
      {
        sequence: 0,
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
        engineSentenceIndex: 0,
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
