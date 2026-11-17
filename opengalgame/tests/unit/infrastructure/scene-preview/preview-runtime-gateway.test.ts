import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  PlayPreviewDialogueRequest,
  RebasePreviewRuntimeRequest
} from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type { PreviewRuntimeEventVO } from '@application/scene-preview/vo/PreviewRuntimeVO'
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
import {
  SceneOverlayUnavailable,
  type SceneOverlayUnavailableReason,
  type SceneTextOverlay,
  type SceneTextOverlayScope,
  type WebgalPreviewConnection,
  type WebgalRuntimeHandle,
  type WebgalRuntimeHost
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

describe('预览运行时网关的端口与换代护栏', () => {
  it('准备先确认台词存在再绑定工程，无效台词或入口不启动宿主', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)

    const missingDialogue = await gateway.prepare({ ...prepareRequest('scene-a'), dialogueId: '9' })
    const missingEntry = await gateway.prepare({ ...prepareRequest('scene-b'), entryFile: '' })

    expect(missingDialogue).toMatchObject({
      status: 'failed',
      failure: { code: 'prepareFailed', recovery: 'prepare' }
    })
    expect(missingEntry).toMatchObject({
      status: 'failed',
      failure: { code: 'prepareFailed', recovery: 'prepare' }
    })
    expect(host.boundRoots).toEqual([])
    expect(host.startCount).toBe(0)
    await gateway.dispose()
  })

  it('换代接口对不存在或已释放会话静默返回', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    const rebase = (
      previewSessionId: string,
      runtimeGeneration: number
    ): RebasePreviewRuntimeRequest => ({
      previewSessionId,
      contentBasis: { ...basis, digest: `digest-${runtimeGeneration}` },
      runtimeGeneration,
      scene: sceneFor('0')
    })

    await expect(gateway.rebaseSession(rebase('missing', 2))).resolves.toBeUndefined()
    expect(host.startCount).toBe(0)

    await gateway.prepare(prepareRequest('scene-a'))
    await gateway.release({ previewSessionId: 'scene-a' })
    await expect(gateway.rebaseSession(rebase('scene-a', 2))).resolves.toBeUndefined()

    await gateway.dispose()
  })

  it('准备只在代次变化时清理覆盖层，并让在途定位不再确认', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    await gateway.prepare(prepareRequest('scene-a'))
    host.markReady(0)
    await gateway.setSceneTextOverlay(overlayRequest('scene-a', 2))

    const same = await gateway.prepare(prepareRequest('scene-a'))
    expect(same).toMatchObject({ status: 'ready', stage: { runtimeGeneration: 1 } })
    expect(host.clearScopes).toEqual([])
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1))
    ).rejects.toMatchObject({ name: 'SceneOverlayRejected', code: 'staleRuntimeGeneration' })

    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    const changed = await gateway.prepare({ ...prepareRequest('scene-a'), runtimeGeneration: 2 })

    expect(changed).toMatchObject({
      status: 'ready',
      stage: { runtimeGeneration: 2, sequence: 1 }
    })
    expect(host.clearScopes).toEqual([{ previewSessionId: 'scene-a' }])
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1, 2))
    ).resolves.toBeUndefined()
    await expect(playing).resolves.toMatchObject({ status: 'failed' })
    await gateway.dispose()
  })

  it('定位等待就绪时换代按旧代次失败，不发送定位命令', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    await gateway.prepare(prepareRequest('scene-a'))
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
    host.markReady(0)

    await expect(playing).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'staleRuntimeGeneration' }
    })
    expect(sentTypes(host.connectionList[0])).not.toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('释放中止等待中的定位，未知会话与重复释放保持幂等', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    await gateway.prepare(prepareRequest('scene-a'))
    const seen: PreviewRuntimeEventVO[] = []
    const unsubscribe = gateway.subscribe({ previewSessionId: 'scene-a' }, (event) =>
      seen.push(event)
    )
    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })

    await gateway.release({ previewSessionId: 'scene-a' })
    await expect(playing).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'runtimeNotReady' }
    })
    await gateway.release({ previewSessionId: 'scene-a' })
    await expect(gateway.release({ previewSessionId: 'missing' })).resolves.toBeUndefined()
    unsubscribe()
    gateway.subscribe({ previewSessionId: 'scene-a' }, (event) => seen.push(event))()
    host.connectionList[0].emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seen).toEqual([])
    await gateway.dispose()
  })

  it('释放只清理属于自己的覆盖层，不影响其他会话的全局覆盖槽', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    await gateway.prepare(prepareRequest('scene-a'))
    await gateway.prepare(prepareRequest('scene-b'))
    await gateway.setSceneTextOverlay(overlayRequest('scene-a', 2))

    await gateway.release({ previewSessionId: 'scene-b' })

    expect(host.clearScopes).toEqual([])
    expect(host.overlay).toMatchObject({ previewSessionId: 'scene-a', editRevision: 2 })
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1))
    ).rejects.toMatchObject({ code: 'staleRuntimeGeneration' })

    await gateway.release({ previewSessionId: 'scene-a' })
    expect(host.clearScopes).toEqual([{ previewSessionId: 'scene-a' }])
    expect(host.overlay).toBeUndefined()
    await gateway.dispose()
  })
})

describe('预览运行时网关的覆盖层护栏', () => {
  it('场景覆盖按会话、代次和宿主原因映射，清除按代次保留网关槽', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    await gateway.prepare(prepareRequest('scene-a'))

    await expect(
      gateway.setSceneTextOverlay(overlayRequest('missing', 1))
    ).rejects.toMatchObject({ name: 'SceneOverlayRejected', code: 'sessionNotFound' })
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1, 2))
    ).rejects.toMatchObject({ name: 'SceneOverlayRejected', code: 'staleRuntimeGeneration' })
    expect(host.overlayCalls).toEqual([])

    await gateway.setSceneTextOverlay(overlayRequest('scene-a', 2))
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1))
    ).rejects.toMatchObject({ name: 'SceneOverlayRejected', code: 'staleRuntimeGeneration' })
    expect(host.overlayCalls).toHaveLength(1)

    const mappings: readonly (readonly [SceneOverlayUnavailableReason, string])[] = [
      ['stale-generation', 'staleRuntimeGeneration'],
      ['stale-revision', 'invalidRequest'],
      ['digest-mismatch', 'invalidRequest'],
      ['invalid-overlay', 'invalidRequest'],
      ['foreign-session', 'sessionNotFound']
    ]
    for (const [reason, code] of mappings) {
      host.overlayFailures.push(reason)
      await expect(
        gateway.setSceneTextOverlay(overlayRequest('scene-a', 3))
      ).rejects.toMatchObject({ name: 'SceneOverlayRejected', code })
    }
    host.overlayFailures.push('plain-error')
    await expect(gateway.setSceneTextOverlay(overlayRequest('scene-a', 4))).rejects.toThrow(
      '宿主覆盖通道错误'
    )

    const readScope: SceneTextOverlayScope = {
      previewSessionId: 'scene-a',
      runtimeGeneration: 1
    }
    await expect(gateway.currentSceneTextOverlayRevision(readScope)).resolves.toBe(2)
    expect(host.currentScopes.at(-1)).toEqual(readScope)

    await gateway.clearSceneTextOverlay({ previewSessionId: 'scene-a', runtimeGeneration: 2 })
    expect(host.clearScopes.at(-1)).toEqual({
      previewSessionId: 'scene-a',
      runtimeGeneration: 2
    })
    await expect(
      gateway.currentSceneTextOverlayRevision({
        previewSessionId: 'scene-a',
        runtimeGeneration: 2
      })
    ).resolves.toBe(0)
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1))
    ).rejects.toMatchObject({ code: 'staleRuntimeGeneration' })

    await gateway.clearSceneTextOverlay({ previewSessionId: 'scene-a' })
    expect(host.overlay).toBeUndefined()
    await gateway.setSceneTextOverlay(overlayRequest('scene-a', 1))
    await expect(
      gateway.currentSceneTextOverlayRevision({
        previewSessionId: 'scene-a',
        runtimeGeneration: 1
      })
    ).resolves.toBe(1)

    await gateway.release({ previewSessionId: 'scene-a' })
    await expect(
      gateway.setSceneTextOverlay(overlayRequest('scene-a', 1))
    ).rejects.toMatchObject({ name: 'SceneOverlayRejected', code: 'sessionNotFound' })
    await gateway.dispose()
  })
})

describe('预览运行时网关的连接与事件过滤', () => {
  it('构造先订阅连接再重放已有连接，重复投递不会重复注册', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    const connection = host.connectionList[0]

    expect(host.calls).toEqual(['onPreviewConnection', 'previewConnections'])
    expect(connection.listenerCount()).toBe(2)
    host.markReady(0)
    expect(countSent(connection, 'response', 'session.register-preview')).toBe(1)
    host.deliver(0)
    expect(connection.listenerCount()).toBe(2)
    expect(countSent(connection, 'response', 'session.register-preview')).toBe(1)

    await gateway.prepare(prepareRequest('scene-a'))
    connection.answerSync({ sceneName: 'start.txt', sentenceId: 1 })
    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ status: 'confirmed' })
    expect(sentTypes(connection)).toContain('preview.command.sync-scene')

    await gateway.dispose()
    expect(connection.listenerCount()).toBe(0)
    expect(host.listenerCount()).toBe(0)
  })

  it('首个就绪连接被所有会话共用，不按会话归属选择', async () => {
    const host = new ControlledRuntimeHost(2)
    const gateway = gatewayWith(host)
    host.markReady(0)
    host.markReady(1)
    await gateway.prepare(prepareRequest('scene-a'))
    host.connectionList[0].answerSync({ sceneName: 'start.txt', sentenceId: 1 })
    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ status: 'confirmed' })

    await gateway.prepare(prepareRequest('scene-b'))
    await expect(
      gateway.playDialogue({
        ...prepareRequest('scene-b'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
    ).resolves.toMatchObject({ status: 'confirmed' })

    const first = host.connectionList[0]
    const second = host.connectionList[1]
    expect(
      sentTypes(first).filter((type) => type === 'preview.command.sync-scene')
    ).toHaveLength(2)
    expect(sentTypes(second)).not.toContain('preview.command.sync-scene')
    await gateway.dispose()
  })

  it('舞台快照只转发当前活跃会话，跨场景与释放后的快照被过滤', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    host.markReady(0)
    await gateway.prepare(prepareRequest('scene-a'))
    const seenA: PreviewRuntimeEventVO[] = []
    gateway.subscribe({ previewSessionId: 'scene-a' }, (event) => seenA.push(event))
    await gateway.prepare(prepareRequest('scene-b'))
    const seenB: PreviewRuntimeEventVO[] = []
    gateway.subscribe({ previewSessionId: 'scene-b' }, (event) => seenB.push(event))
    const connection = host.connectionList[0]

    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'other.txt', sentenceId: 1 }
    })
    expect(seenA).toEqual([])
    expect(seenB).toEqual([])

    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seenA).toEqual([])
    expect(seenB.at(-1)).toMatchObject({
      type: 'stage',
      previewSessionId: 'scene-b',
      runtimeGeneration: 1,
      sequence: 2,
      position: { kind: 'dialogue', dialogueId: '0' }
    })

    await gateway.release({ previewSessionId: 'scene-b' })
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seenA).toEqual([])
    expect(seenB).toHaveLength(1)

    await gateway.prepare(prepareRequest('scene-a'))
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seenA.at(-1)).toMatchObject({
      type: 'stage',
      previewSessionId: 'scene-a',
      runtimeGeneration: 1,
      sequence: 2,
      position: { kind: 'dialogue', dialogueId: '0' }
    })
    await gateway.dispose()
  })

  it('定位必须在匹配响应之后接受同场景停止指针快照，迟到消息不回填旧命令', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host, { timeoutMs: 20 })
    host.markReady(0)
    await gateway.prepare(prepareRequest('scene-a'))
    const connection = host.connectionList[0]
    const seen: PreviewRuntimeEventVO[] = []
    gateway.subscribe({ previewSessionId: 'scene-a' }, (event) => seen.push(event))

    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    const requestId = lastRequestId(connection, 'preview.command.sync-scene')
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    connection.emit({
      kind: 'response',
      type: 'preview.command.other',
      requestId,
      payload: {}
    })
    connection.emit({
      kind: 'response',
      type: 'preview.command.sync-scene',
      requestId: 'other',
      payload: {}
    })
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seen).toEqual([])
    await expect(playing).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'locateNotReached' }
    })
    expect(seen).toEqual([])

    connection.emit({
      kind: 'response',
      type: 'preview.command.sync-scene',
      requestId,
      payload: {}
    })
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seen.at(-1)).toMatchObject({
      type: 'stage',
      previewSessionId: 'scene-a',
      runtimeGeneration: 1,
      sequence: 2,
      position: { kind: 'dialogue', dialogueId: '0' }
    })

    let settled = false
    const second = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })
    void second.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    const secondRequestId = lastRequestId(connection, 'preview.command.sync-scene')
    connection.emit({
      kind: 'response',
      type: 'preview.command.sync-scene',
      requestId: secondRequestId,
      payload: {}
    })
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'other.txt', sentenceId: 9 }
    })
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 0 }
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    await expect(second).resolves.toMatchObject({ status: 'confirmed' })
    await gateway.dispose()
  })

  it('单个监听器抛错不影响其他监听器，退订后不再收到事件', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    host.markReady(0)
    await gateway.prepare(prepareRequest('scene-a'))
    const connection = host.connectionList[0]
    const seen: number[] = []
    gateway.subscribe({ previewSessionId: 'scene-a' }, () => {
      throw new Error('监听器失败')
    })
    const unsubscribe = gateway.subscribe({ previewSessionId: 'scene-a' }, (event) =>
      seen.push(event.sequence)
    )

    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seen).toEqual([2])

    unsubscribe()
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seen).toEqual([2])

    gateway.subscribe({ previewSessionId: 'missing' }, (event) => seen.push(event.sequence))()
    connection.emit({
      kind: 'event',
      type: 'stage.snapshot.updated',
      payload: { sceneName: 'start.txt', sentenceId: 1 }
    })
    expect(seen).toEqual([2])
    await gateway.dispose()
  })

  it('销毁释放宿主与连接监听，结束等待并清空会话', async () => {
    const host = new ControlledRuntimeHost(1)
    const gateway = gatewayWith(host)
    await gateway.prepare(prepareRequest('scene-a'))
    const connection = host.connectionList[0]
    const playing = gateway.playDialogue({
      ...prepareRequest('scene-a'),
      expectedRuntimeGeneration: 1,
      dialogueId: '0',
      scene: sceneFor('0')
    })

    await gateway.dispose()

    await expect(playing).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'runtimeNotReady' }
    })
    expect(connection.listenerCount()).toBe(0)
    expect(host.listenerCount()).toBe(0)
    await expect(gateway.dispose()).resolves.toBeUndefined()
    await expect(gateway.release({ previewSessionId: 'scene-a' })).resolves.toBeUndefined()
    expect(
      gateway.subscribe({ previewSessionId: 'scene-a' }, () => undefined)
    ).toBeInstanceOf(Function)
    host.markReady(0)
    expect(countSent(connection, 'response', 'session.register-preview')).toBe(0)
  })

  it('未显式配置时命令超时保持 5 秒、启动超时保持 20 秒', async () => {
    vi.useFakeTimers()
    const host = new ControlledRuntimeHost(1)
    const gateway = new PreviewRuntimeGatewayImpl({
      host,
      bridge: new WebgalPreviewControlBridge(host),
      trustedInput: () => ({
        stagePageUrl: 'http://127.0.0.1:9/__opengalgame/stage-input/test',
        readScreen: async () => null,
        click: async () => undefined,
        waitForLanguageDismissed: async () => undefined
      })
    })
    try {
      await gateway.prepare(prepareRequest('scene-a'))
      let waitingCode: string | undefined
      const waiting = gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
      void waiting.then((result) => {
        waitingCode = result.status === 'failed' ? result.failure.code : 'confirmed'
      })

      await vi.advanceTimersByTimeAsync(4_999)
      expect(waitingCode).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(waitingCode).toBe('runtimeNotReady')

      host.markReady(0)
      let startingCode: string | undefined
      const starting = gateway.playDialogue({
        ...prepareRequest('scene-a'),
        expectedRuntimeGeneration: 1,
        dialogueId: '0',
        scene: sceneFor('0')
      })
      void starting.then((result) => {
        startingCode = result.status === 'failed' ? result.failure.code : 'confirmed'
      })

      await vi.advanceTimersByTimeAsync(19_999)
      expect(startingCode).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(startingCode).toBe('commandTimeout')
    } finally {
      vi.useRealTimers()
      await gateway.dispose()
    }
  })
})

function gatewayFor(host: ScriptedPreviewHost): PreviewRuntimeGatewayImpl {
  return new PreviewRuntimeGatewayImpl({
    host,
    bridge: new WebgalPreviewControlBridge(host),
    timeoutMs: 20
  })
}

function gatewayWith(
  host: WebgalRuntimeHost,
  options: {
    readonly timeoutMs?: number
    readonly startupTimeoutMs?: number
    readonly trustedInput?: CandidateTrustedInputSource
  } = {}
): PreviewRuntimeGatewayImpl {
  return new PreviewRuntimeGatewayImpl({
    host,
    bridge: new WebgalPreviewControlBridge(host),
    ...options
  })
}

function overlayRequest(
  previewSessionId: string,
  editRevision: number,
  runtimeGeneration = 1,
  text = '旁白:新草稿;\n'
): SceneTextOverlay {
  return {
    previewSessionId,
    sceneFileName: 'start.txt',
    editRevision,
    text,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    runtimeGeneration
  }
}

function sentTypes(connection: ScriptedConnection): readonly string[] {
  return connection.sent.flatMap((message) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return []
    return typeof message.type === 'string' ? [message.type] : []
  })
}

function countSent(connection: ScriptedConnection, kind: string, type: string): number {
  return connection.sent.filter((message) => {
    if (!message || typeof message !== 'object') return false
    if (!('kind' in message) || !('type' in message)) return false
    return message.kind === kind && message.type === type
  }).length
}

function lastRequestId(connection: ScriptedConnection, type: string): string {
  const message = [...connection.sent].reverse().find((item) => {
    if (!item || typeof item !== 'object') return false
    if (!('kind' in item) || !('type' in item) || !('requestId' in item)) return false
    return item.kind === 'request' && item.type === type
  })
  if (!message || typeof message !== 'object' || !('requestId' in message)) {
    throw new Error(`没有找到请求：${type}`)
  }
  if (typeof message.requestId !== 'string') throw new Error(`请求没有 requestId：${type}`)
  return message.requestId
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
  constructor(readonly id = 'scripted-preview') {}
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

const controlledRuntimeHandle: WebgalRuntimeHandle = {
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

class ControlledRuntimeHost implements WebgalRuntimeHost {
  readonly connectionList: ScriptedConnection[]
  readonly calls: string[] = []
  readonly boundRoots: string[] = []
  readonly overlayCalls: SceneTextOverlay[] = []
  readonly currentScopes: SceneTextOverlayScope[] = []
  readonly clearScopes: SceneTextOverlayScope[] = []
  readonly overlayFailures: (SceneOverlayUnavailableReason | 'plain-error')[] = []
  overlay: SceneTextOverlay | undefined
  startCount = 0
  private readonly listeners = new Set<(connection: WebgalPreviewConnection) => void>()

  constructor(connectionCount: number) {
    this.connectionList = Array.from(
      { length: connectionCount },
      (_, index) => new ScriptedConnection(`controlled-${index + 1}`)
    )
  }

  markReady(index: number): void {
    const connection = this.connectionList[index]
    connection.emit({
      kind: 'request',
      type: 'session.register-preview',
      requestId: `register-${connection.id}`,
      payload: {}
    })
    connection.emit({
      kind: 'event',
      type: 'preview.ready.updated',
      payload: { ready: true }
    })
  }

  deliver(index: number): void {
    for (const listener of this.listeners) listener(this.connectionList[index])
  }

  listenerCount(): number {
    return this.listeners.size
  }

  async start(): Promise<WebgalRuntimeHandle> {
    this.startCount += 1
    return controlledRuntimeHandle
  }

  onPreviewConnection(listener: (connection: WebgalPreviewConnection) => void): () => void {
    this.calls.push('onPreviewConnection')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onRequest(): () => void {
    return () => undefined
  }

  getHandle(): WebgalRuntimeHandle | undefined {
    return controlledRuntimeHandle
  }

  useProjectRoot(projectRoot: string): Promise<void> {
    if (projectRoot.trim() === '' || projectRoot.includes('..')) {
      return Promise.reject(new Error('预览工程根不可用'))
    }
    this.boundRoots.push(projectRoot)
    return Promise.resolve()
  }

  setSceneTextOverlay(overlay: SceneTextOverlay): Promise<void> {
    this.overlayCalls.push(overlay)
    const failure = this.overlayFailures.shift()
    if (failure === 'plain-error') {
      return Promise.reject(new Error('宿主覆盖通道错误'))
    }
    if (failure !== undefined) {
      return Promise.reject(new SceneOverlayUnavailable(failure))
    }
    if (this.overlay && this.overlay.previewSessionId !== overlay.previewSessionId) {
      return Promise.reject(new SceneOverlayUnavailable('foreign-session'))
    }
    if (
      this.overlay &&
      this.overlay.sceneFileName === overlay.sceneFileName &&
      overlay.editRevision < this.overlay.editRevision
    ) {
      return Promise.reject(new SceneOverlayUnavailable('stale-revision'))
    }
    if (
      this.overlay &&
      this.overlay.sceneFileName === overlay.sceneFileName &&
      overlay.runtimeGeneration < this.overlay.runtimeGeneration
    ) {
      return Promise.reject(new SceneOverlayUnavailable('stale-generation'))
    }
    this.overlay = overlay
    return Promise.resolve()
  }

  currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number> {
    this.currentScopes.push(scope)
    if (!this.overlay || this.overlay.previewSessionId !== scope.previewSessionId) {
      return Promise.resolve(0)
    }
    if (
      scope.runtimeGeneration !== undefined &&
      this.overlay.runtimeGeneration !== scope.runtimeGeneration
    ) {
      return Promise.resolve(0)
    }
    return Promise.resolve(this.overlay.editRevision)
  }

  clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void> {
    this.clearScopes.push(scope)
    if (!this.overlay || this.overlay.previewSessionId !== scope.previewSessionId) {
      return Promise.resolve()
    }
    if (
      scope.runtimeGeneration !== undefined &&
      this.overlay.runtimeGeneration !== scope.runtimeGeneration
    ) {
      return Promise.resolve()
    }
    this.overlay = undefined
    return Promise.resolve()
  }

  previewConnections(): readonly WebgalPreviewConnection[] {
    this.calls.push('previewConnections')
    return [...this.connectionList]
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
  }
}
