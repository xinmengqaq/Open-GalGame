import { describe, expect, it } from 'vitest'

import type { CandidatePreviewSession } from '@application/scenes/models/CandidatePreviewSession'
import type { ParsedScene } from '@application/scenes/models/ParsedScene'
import type { SceneSourceSnapshot } from '@application/scenes/models/SceneSourceSnapshot'
import type { CandidatePreviewSessionGateway } from '@application/scenes/ports/CandidatePreviewSessionGateway'
import type { SceneAssetReferenceGateway } from '@application/scenes/ports/SceneAssetReferenceGateway'
import type { SceneScriptParserGateway } from '@application/scenes/ports/SceneScriptParserGateway'
import type { SceneSourceReaderGateway } from '@application/scenes/ports/SceneSourceReaderGateway'
import type { ScenePreviewSourceFact } from '@application/scene-preview/models/ScenePreviewSourceFact'
import type { SceneCompatibilityGateway } from '@application/scene-preview/ports/SceneCompatibilityGateway'
import type { SceneDialogueRevisionGateway } from '@application/scene-preview/ports/SceneDialogueRevisionGateway'
import type { ScenePreviewArtifactGateway } from '@application/scene-preview/ports/ScenePreviewArtifactGateway'
import type {
  PlayPreviewDialogueRequest,
  PreviewRuntimeGateway
} from '@application/scene-preview/ports/PreviewRuntimeGateway'
import { SceneOverlayRejected } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type { PreviewSaveVersionGateway } from '@application/scene-preview/ports/PreviewSaveVersionGateway'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import { SceneCandidatePreviewApplicationServiceImpl } from '@application/scene-preview/services/impl/SceneCandidatePreviewApplicationServiceImpl'
import { ScenePreviewApplicationServiceImpl } from '@application/scene-preview/services/impl/ScenePreviewApplicationServiceImpl'
import type { DialogueSaveSettlementVO } from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewRuntimeListener,
  PreviewStageVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ScenePreviewErrorCodes } from '@domain/scene-preview/errors/ScenePreviewErrorCodes'

const basis = { digest: 'digest-1', parserVersion: 'parser-1', engineVersion: 'engine-1' }

function source(digest = basis.digest, text = '原来的一句'): ScenePreviewSourceFact {
  const script = `${text}\n后面一句`
  const file = {
    relativePath: 'game/scene/start.txt',
    kind: 'entry' as const,
    bytes: new Uint8Array(),
    text: script,
    size: script.length,
    modifiedAtMs: 1,
    digest
  }
  const snapshot: SceneSourceSnapshot = {
    projectRoot: 'D:/project',
    entryFile: file,
    files: [file],
    missingMetadataFiles: [],
    digest
  }
  const say = (
    sequence: number,
    content: string,
    offset: number
  ): ParsedScene['sentences'][number] => ({
    sequence,
    command: 'say',
    commandRaw: `旁白:${content};`,
    content,
    rawContent: content,
    arguments: [],
    inlineComment: '',
    sourceRange: {
      startOffset: offset,
      endOffset: offset + content.length,
      startLine: sequence,
      startColumn: 0,
      endLine: sequence,
      endColumn: content.length
    },
    contentRange: {
      startOffset: offset,
      endOffset: offset + content.length,
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
  const parsed: ParsedScene = {
    sourceFile: file,
    contentDigest: digest,
    sentences: [say(1, text, 0), say(4, '后面一句', text.length + 1)],
    assets: [],
    subScenes: [],
    diagnostics: []
  }
  return {
    location: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: snapshot.projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: file.relativePath
    },
    snapshot,
    parsed,
    references: [],
    contentBasis: { ...basis, digest },
    lockState: 'editable',
    sceneName: 'start',
    dialogues: [
      { dialogueId: '1', text, located: true },
      { dialogueId: '4', text: '后面一句', located: true }
    ],
    issues: []
  }
}

function stage(
  previewSessionId: string,
  generation: number,
  digest = basis.digest,
  dialogueId = '1',
  sequence = generation,
  located = true
): PreviewStageVO {
  return {
    previewSessionId,
    contentBasis: { ...basis, digest },
    runtimeGeneration: generation,
    sequence,
    phase: 'unknown',
    position: located ? { kind: 'dialogue', dialogueId } : { kind: 'unknown' }
  }
}

function createPreview() {
  const writes: string[] = []
  const settlements = new Map<string, DialogueSaveSettlementVO>()
  const state: {
    digest: string
    text: string
    fileDigest: string
    releases: number
    played: string[]
    playedScenes: ParsedScene[]
    overlays: string[]
    rebases: { runtimeGeneration: number; digest: string }[]
    cleared: number
    acceptedRevision: number
    override?: ScenePreviewSourceFact
    beforeCommit: Promise<void>
    beforeRead: Promise<void>
    beforeSettlement: Promise<void> | undefined
    commitEntered: number
    settlementEntered: number
    onCommitEntry: (() => void) | undefined
    onSettlementEntry: (() => void) | undefined
    commit: 'saved' | 'pending'
    failNextPlay: boolean
  } = {
    digest: basis.digest,
    text: '原来的一句',
    fileDigest: basis.digest,
    releases: 0,
    played: [],
    playedScenes: [],
    overlays: [],
    rebases: [],
    acceptedRevision: 0,
    cleared: 0,
    beforeCommit: Promise.resolve(),
    beforeRead: Promise.resolve(),
    beforeSettlement: undefined,
    commitEntered: 0,
    settlementEntered: 0,
    onCommitEntry: undefined,
    onSettlementEntry: undefined,
    commit: 'saved',
    failNextPlay: false
  }
  const versions: PreviewSaveVersionGateway = {
    commitPreviewSave: async (request) => {
      state.commitEntered += 1
      state.onCommitEntry?.()
      state.onCommitEntry = undefined
      await state.beforeCommit
      if (state.commit === 'pending') return { status: 'pendingVerification' }
      writes.push(request.editsSnapshot)
      state.text = request.committedEdits[0]?.text ?? state.text
      state.fileDigest = 'revision-1'
      const settlement: DialogueSaveSettlementVO = {
        status: 'saved',
        contentBasis: { ...basis, digest: state.digest },
        committedEdits: request.committedEdits
      }
      settlements.set(`${request.requestId}\0${request.editsSnapshot}`, settlement)
      return { status: 'committed', contentBasis: settlement.contentBasis }
    },
    readPreviewSaveSettlement: async (request) => {
      state.settlementEntered += 1
      state.onSettlementEntry?.()
      state.onSettlementEntry = undefined
      if (state.beforeSettlement) await state.beforeSettlement
      const key = `${request.requestId}\0${request.editsSnapshot ?? ''}`
      if (request.editsSnapshot && settlements.has(key)) return settlements.get(key)!
      const matches = [...settlements.entries()].filter(([saved]) =>
        saved.startsWith(`${request.requestId}\0`)
      )
      if (matches.length === 0) return { status: 'notFound', request }
      if (!request.editsSnapshot) return matches[0]![1]
      return {
        status: 'conflict',
        request,
        failure: { code: 'saveRequestReused', message: '冲突', recovery: 'none' }
      }
    },
    recordPreviewSaveRefusal: async (request) => {
      if (request.failure.code !== 'sessionClosed') return
      settlements.set(`${request.requestId}\0${request.editsSnapshot}`, {
        status: 'conflict',
        request: {
          projectId: request.projectId,
          sceneId: request.sceneId,
          requestId: request.requestId
        },
        failure: request.failure
      })
    }
  }
  const listeners: PreviewRuntimeListener[] = []
  const runtime: PreviewRuntimeGateway = {
    prepare: async (request) => ({
      status: 'ready',
      stage: stage(
        request.previewSessionId,
        1,
        request.contentBasis.digest,
        request.dialogueId,
        1,
        false
      ),
      stageUrl: 'http://127.0.0.1:9/index.html'
    }),
    rebaseSession: async (request) => {
      state.rebases.push({
        runtimeGeneration: request.runtimeGeneration,
        digest: request.contentBasis.digest
      })
    },
    setSceneTextOverlay: async (request) => {
      if (request.editRevision < state.acceptedRevision) {
        throw new SceneOverlayRejected('staleRuntimeGeneration')
      }
      state.acceptedRevision = request.editRevision
      state.overlays.push(request.text)
    },
    currentSceneTextOverlayRevision: async () => state.acceptedRevision,
    clearSceneTextOverlay: async () => {
      state.cleared += 1
    },
    playDialogue: async (request: PlayPreviewDialogueRequest) => {
      state.played.push(request.dialogueId)
      const sentence = request.scene.sentences.find(
        (item) => String(item.sequence) === request.dialogueId
      )
      state.playedScenes.push(request.scene)
      if (state.failNextPlay) {
        state.failNextPlay = false
        return {
          status: 'failed',
          failure: { code: 'locateNotReached', message: '未到达', recovery: 'none' }
        }
      }
      return {
        status: 'confirmed',
        stage: stage(
          request.previewSessionId,
          request.expectedRuntimeGeneration,
          request.scene.contentDigest,
          request.dialogueId,
          sentence?.engineSentenceIndex ?? 0
        )
      }
    },
    subscribe: (_scope, listener) => {
      listeners.push(listener)
      return () => undefined
    },
    release: async () => {
      state.releases += 1
    }
  }
  let sequence = 0
  const service = new ScenePreviewApplicationServiceImpl({
    artifacts: { readSceneArtifact: async () => ({ status: 'available' }) },
    sources: {
      readScenePreviewSource: async () => {
        await state.beforeRead
        return state.override ?? withFileDigest(source(state.digest, state.text), state.fileDigest)
      }
    },
    revisions: {
      prepareDialogueRevision: async () => ({
        relativePath: 'game/scene/start.txt',
        bytes: new Uint8Array([1]),
        digest: 'revision-1'
      })
    } satisfies SceneDialogueRevisionGateway,
    versions,
    runtime,
    nextId: () => `preview-${++sequence}`
  })
  return {
    service,
    session: (previewSessionId: string) => service['sessions'].find(previewSessionId),
    get releases() {
      return state.releases
    },
    current: state,
    holdRead() {
      const { promise, resolve } = Promise.withResolvers<void>()
      state.beforeRead = promise
      return resolve
    },
    holdCommit() {
      const { promise, resolve } = Promise.withResolvers<void>()
      state.beforeCommit = promise
      return resolve
    },
    pendingCommit() {
      state.commit = 'pending'
    },
    holdSettlement() {
      const { promise, resolve } = Promise.withResolvers<void>()
      state.beforeSettlement = promise
      return resolve
    },
    waitForCommitEntry() {
      if (state.commitEntered > 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        state.onCommitEntry = resolve
      })
    },
    writes,
    waitForSettlementEntry() {
      if (state.settlementEntered > 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        state.onSettlementEntry = resolve
      })
    },
    async waitForAcceptedSave(requestId: string) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const running = await service.readDialogueSaveSettlement({
          projectId: 'project-1',
          sceneId: 'scene-1',
          requestId
        })
        if (running.status === 'pendingVerification') return
        await Promise.resolve()
      }
      throw new Error('第二笔保存没有进入受理队列')
    },
    settlements,
    listeners
  }
}

describe('当前场景预览应用编排', () => {
  it('未变化不写修订，保存后保持当前句，失败后不能准备冒充', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    const unchanged = await preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'same',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '原来的一句' }]
    })
    expect(unchanged.status).toBe('unchanged')
    expect(preview.writes).toEqual([])
    const saved = await preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'changed',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '改后的一句' }]
    })
    expect(saved).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'kept', stage: { position: { dialogueId: '1' } } }
    })
    const blocked = await preview.service.preparePreviewStage({
      previewSessionId: opened.previewSessionId
    })
    expect(blocked).toMatchObject({ failure: { code: 'prepareAlreadyDone' } })
  })

  it('旧代次和旧序号事件不进入监听器', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    const seen: string[] = []
    preview.service.subscribePreviewRuntime(
      { previewSessionId: opened.previewSessionId, projectId: 'project-1', sceneId: 'scene-1' },
      (event) => seen.push(`${event.runtimeGeneration}:${event.sequence}`)
    )
    const listener = preview.listeners[0]
    if (!listener) throw new Error('运行时没有订阅')
    listener({ type: 'stage', ...stage(opened.previewSessionId, 1), sequence: 1 })
    listener({ type: 'stage', ...stage(opened.previewSessionId, 9), sequence: 9 })
    expect(seen).toEqual([])
  })

  it('选中一句后按源脚本序号前后播放，结束后停在当前句', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    const playback = {
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '1'
    }
    const selected = await preview.service.selectPreviewDialogue({ ...playback, dialogueId: '4' })
    const previous = await preview.service.playPreviousDialogue(playback)
    const next = await preview.service.playNextDialogue(playback)
    const finished = await preview.service.playNextDialogue(playback)
    const stayed = await preview.service.playPreviousDialogue(playback)

    expect(selected).toMatchObject({
      status: 'confirmed',
      stage: { position: { dialogueId: '4' } }
    })
    expect(previous).toMatchObject({
      status: 'confirmed',
      stage: { position: { dialogueId: '1' } }
    })
    expect(next).toMatchObject({ status: 'confirmed', stage: { position: { dialogueId: '4' } } })
    expect(finished).toMatchObject({ status: 'failed', failure: { code: 'playbackCompleted' } })
    expect(stayed).toMatchObject({ status: 'confirmed', stage: { position: { dialogueId: '1' } } })
    expect(preview.current.played).toEqual(['4', '1', '4', '1'])
  })

  it('同负载复用同一次提交，不同负载拒绝', async () => {
    const preview = createPreview()
    const release = preview.holdCommit()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const request = {
      previewSessionId: opened.previewSessionId,
      requestId: 'once',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '第一次' }]
    }
    const first = preview.service.saveDialogueChanges(request)
    await Promise.resolve()
    const repeated = preview.service.saveDialogueChanges(request)
    await expect(
      preview.service.saveDialogueChanges({
        ...request,
        edits: [{ dialogueId: '1', text: '另一次' }]
      })
    ).rejects.toMatchObject({ cause: 'saveRequestReused' })
    release()
    expect(await first).toBe(await repeated)
    expect(preview.writes).toHaveLength(1)
  })

  it('关闭后仍结算已受理保存，不把待核对写成失败', async () => {
    const preview = createPreview()
    preview.pendingCommit()
    const release = preview.holdCommit()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const releaseRead = preview.holdRead()
    const saving = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'pending',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '待核对' }]
    })
    const early = await Promise.race([saving, Promise.resolve('waiting' as const)])
    expect(early).toBe('waiting')
    const closed = preview.service.closeScenePreview({ previewSessionId: opened.previewSessionId })
    const closeFirst = await Promise.race([
      closed.then(() => 'closed' as const),
      saving.then(() => 'saved' as const)
    ])
    expect(closeFirst).toBe('closed')
    const seen = await preview.service.readDialogueSaveSettlement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      requestId: 'pending'
    })
    expect(seen.status).toBe('pendingVerification')
    await expect(
      preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    ).rejects.toMatchObject({ cause: 'sessionNotFound' })
    releaseRead()
    release()
    await expect(saving).resolves.toMatchObject({ status: 'pendingVerification' })
    expect(preview.releases).toBe(1)
  })

  it('舞台未准备时，回读依据与保存依据一致才返回已保存', async () => {
    const preview = divergentSave('file-bytes')
    const opened = await preview.openScenePreview({ projectId: 'project-1', sceneId: 'scene-1' })
    const saved = await preview.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'divergent',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '改后的一句' }]
    })
    expect(saved).toMatchObject({
      status: 'saved',
      contentBasis: {
        digest: 'collection-after',
        parserVersion: 'parser-1',
        engineVersion: 'engine-1'
      },
      committedEdits: [{ dialogueId: '1', text: '改后的一句' }],
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    await expect(
      preview.readDialogueSaveSettlement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        requestId: 'divergent'
      })
    ).resolves.toMatchObject({
      status: 'saved',
      contentBasis: { digest: 'collection-after' },
      committedEdits: [{ dialogueId: '1', text: '改后的一句' }]
    })
  })

  it('修订字节没有出现在回读文件时保持待核对', async () => {
    const preview = divergentSave('other-bytes')
    const opened = await preview.openScenePreview({ projectId: 'project-1', sceneId: 'scene-1' })
    const saved = await preview.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'divergent',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '改后的一句' }]
    })
    expect(saved).toMatchObject({
      status: 'pendingVerification',
      failure: { code: 'saveOutcomeUnknown' }
    })
    await expect(
      preview.readDialogueSaveSettlement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        requestId: 'divergent'
      })
    ).resolves.toMatchObject({ status: 'saved', contentBasis: { digest: 'collection-after' } })
  })

  it('关闭赶在受理前时，旧保存不能把会话放回', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const release = preview.holdSettlement()
    const saving = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'late',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '来不及的一句' }]
    })
    await preview.waitForSettlementEntry()
    await preview.service.closeScenePreview({ previewSessionId: opened.previewSessionId })
    release()
    await expect(saving).rejects.toMatchObject({ cause: 'sessionClosed' })
    await expect(
      preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    ).rejects.toMatchObject({ cause: 'sessionNotFound' })
    expect(preview.releases).toBe(1)
    expect(preview.writes).toHaveLength(0)
  })

  it('重叠保存串行，等待期间的代次不会被旧会话盖掉', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const release = preview.holdCommit()
    const first = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'first',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '第一句' }]
    })
    await preview.waitForCommitEntry()
    const second = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'second',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '第二句' }]
    })
    await Promise.resolve()
    expect(preview.current.commitEntered).toBe(1)
    release()
    await expect(first).resolves.toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    await expect(second).resolves.toMatchObject({
      status: 'saved',
      committedEdits: [{ dialogueId: '1', text: '第二句' }],
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    expect(preview.current.commitEntered).toBe(2)
    expect(preview.writes).toHaveLength(2)
  })

  it('排队中的第二笔遇关闭时，即时结果和事后结算一致且不是未找到', async () => {
    const preview = createPreview()
    const release = preview.holdCommit()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const first = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'first',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '第一句' }]
    })
    await preview.waitForCommitEntry()
    const second = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'second',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '第二句' }]
    })
    await preview.waitForAcceptedSave('second')
    const closed = preview.service.closeScenePreview({ previewSessionId: opened.previewSessionId })
    const closeFirst = await Promise.race([
      closed.then(() => 'closed' as const),
      second.then(
        () => 'saved' as const,
        () => 'rejected' as const
      )
    ])
    expect(closeFirst).toBe('closed')
    release()
    const immediate = await second
    const later = await preview.service.readDialogueSaveSettlement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      requestId: 'second'
    })
    expect(later.status).not.toBe('notFound')
    expect(immediate.status).not.toBe('pendingVerification')
    if (immediate.status === 'saved' || immediate.status === 'unchanged') {
      expect(later.status).toBe(immediate.status)
    } else {
      expect(immediate.status).toBe('rejected')
      expect(later).toMatchObject({ status: 'conflict', failure: immediate.failure })
    }
    await expect(first).resolves.toMatchObject({ status: 'saved' })
  })

  it('保存等待期间准备舞台后，完成的保存不退回旧代次', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const release = preview.holdCommit()
    const saving = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'during-prepare',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '准备期间的一句' }]
    })
    await preview.waitForCommitEntry()
    const prepared = await preview.service.preparePreviewStage({
      previewSessionId: opened.previewSessionId
    })
    expect(prepared.status).toBe('ready')
    release()
    const finished = await saving
    expect(finished).toMatchObject({
      status: 'saved',
      runtimeGeneration: 2,
      previewUpdate: { status: 'kept', stage: { position: { dialogueId: '1' } } }
    })
    expect(preview.current.rebases).toEqual([{ runtimeGeneration: 2, digest: basis.digest }])
    await expect(
      preview.service.selectPreviewDialogue({
        previewSessionId: opened.previewSessionId,
        expectedRuntimeGeneration: 2,
        dialogueId: '4'
      })
    ).resolves.toMatchObject({ status: 'confirmed', stage: { position: { dialogueId: '4' } } })
    await expect(
      preview.service.selectPreviewDialogue({
        previewSessionId: opened.previewSessionId,
        expectedRuntimeGeneration: 1,
        dialogueId: '1'
      })
    ).rejects.toMatchObject({ cause: 'staleRuntimeGeneration' })
  })

  it('同负载重放保持当时的预览更新，不重复提交或改当前句', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    const request = {
      previewSessionId: opened.previewSessionId,
      requestId: 'replay',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '改后的一句' }]
    }
    const first = await preview.service.saveDialogueChanges(request)
    const repeated = await preview.service.saveDialogueChanges(request)
    expect(first).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    expect(repeated).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    expect(preview.current.commitEntered).toBe(1)
    expect(preview.writes).toHaveLength(1)

    const prepared = createPreview()
    const ready = await prepared.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await prepared.service.preparePreviewStage({ previewSessionId: ready.previewSessionId })
    await prepared.service.selectPreviewDialogue({
      previewSessionId: ready.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4'
    })
    const readyRequest = {
      previewSessionId: ready.previewSessionId,
      requestId: 'kept',
      baseContentBasis: ready.contentBasis,
      edits: [{ dialogueId: '1', text: '恢复后的一句' }]
    }
    const saved = await prepared.service.saveDialogueChanges(readyRequest)
    const replayed = await prepared.service.saveDialogueChanges(readyRequest)
    expect(saved).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'kept', stage: { position: { dialogueId: '4' } } }
    })
    expect(replayed).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'kept', stage: { position: { dialogueId: '4' } } }
    })
    expect(prepared.current.commitEntered).toBe(1)
    expect(prepared.current.played.filter((dialogueId) => dialogueId === '4')).toHaveLength(2)

    await prepared.service.closeScenePreview({ previewSessionId: ready.previewSessionId })
    const closed = await prepared.service.saveDialogueChanges(readyRequest)
    expect(closed).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'unavailable', reason: 'sessionClosed' }
    })
    expect(prepared.current.commitEntered).toBe(1)
  })

  it('没有正文范围的草稿保持左栏内容且不写源', async () => {
    const preview = createPreview()
    const fact = source()
    const second = fact.parsed.sentences[1]
    if (!second) throw new Error('测试台词不存在')
    fact.parsed = {
      ...fact.parsed,
      sentences: [fact.parsed.sentences[0]!, { ...second, contentRange: undefined }]
    }
    preview.current.override = fact
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    const draft = await preview.service.previewDialogueDraft({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4',
      editRevision: 1,
      text: '不能覆盖'
    })
    expect(draft).toEqual({ status: 'unavailable', reason: 'dialogueNotMounted' })
    expect(preview.current.overlays).toEqual([])
    expect(preview.writes).toEqual([])
  })

  it('草稿按正文范围覆盖并重新定位，保存后清覆盖再定位原句', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    await preview.service.selectPreviewDialogue({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4'
    })
    const applied = await preview.service.previewDialogueDraft({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '1',
      editRevision: 1,
      text: '草稿一句'
    })
    const saved = await preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'overlay-save',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '已保存一句' }]
    })
    expect(applied).toMatchObject({ status: 'applied', dialogueId: '1' })
    expect(preview.current.overlays[0]).toContain('草稿一句')
    expect(saved.status).toBe('saved')
    expect(preview.current.cleared).toBe(1)
    expect(preview.current.played.at(-1)).toBe('1')
    expect(preview.writes).toHaveLength(1)
  })

  it('旧草稿修订不能覆盖新修订，草稿本身不写源', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    const draft = {
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4',
      text: '新草稿'
    }
    const newer = await preview.service.previewDialogueDraft({ ...draft, editRevision: 2 })
    const before = preview.current.overlays.length
    const older = await preview.service.previewDialogueDraft({ ...draft, editRevision: 1 })
    expect(newer).toMatchObject({ status: 'applied', editRevision: 2 })
    expect(older).toEqual({ status: 'unavailable', reason: 'staleRuntimeGeneration' })
    expect(preview.current.overlays).toHaveLength(before)
    expect(preview.current.acceptedRevision).toBe(2)
  })

  it('保存改变源后按新源重定位，等待中的新草稿仍留在舞台', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    await preview.service.selectPreviewDialogue({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4'
    })
    const release = preview.holdCommit()
    const saving = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'new-source',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '已保存一句' }]
    })
    await preview.waitForCommitEntry()
    preview.current.digest = 'digest-saved'
    preview.current.text = '已保存一句'
    const draft = await preview.service.previewDialogueDraft({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4',
      editRevision: 3,
      text: '保存期间草稿'
    })
    expect(draft.status).toBe('applied')
    release()
    const saved = await saving
    expect(saved.status).toBe('saved')
    expect(preview.current.played.at(-1)).toBe('4')
    expect(preview.current.playedScenes.at(-1)?.contentDigest).toBe('digest-saved')
    const kept = preview.session(opened.previewSessionId)
    expect(kept?.source.contentBasis.digest).toBe('digest-saved')
    expect(kept?.unsavedEdits.get('4')?.text).toBe('保存期间草稿')
  })

  it('保存期间同一句的新草稿不被已保存快照清除', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    const scope = {
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '1'
    }
    await preview.service.previewDialogueDraft({ ...scope, editRevision: 1, text: '准备保存' })
    const release = preview.holdCommit()
    const saving = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'same-dialogue-draft',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '准备保存' }]
    })
    await preview.waitForCommitEntry()
    await preview.service.previewDialogueDraft({
      ...scope,
      editRevision: 2,
      text: '保存期间继续编辑'
    })
    release()
    const saved = await saving
    expect(saved).toMatchObject({
      status: 'saved',
      committedEdits: [{ dialogueId: '1', text: '准备保存' }],
      previewUpdate: { status: 'kept' }
    })
    expect(preview.session(opened.previewSessionId)?.unsavedEdits.get('1')).toEqual({
      dialogueId: '1',
      text: '保存期间继续编辑',
      editRevision: 2
    })
    expect(preview.current.overlays.at(-1)).toBe('保存期间继续编辑\n后面一句')
  })

  it('覆盖已接受但定位失败时仍保留左栏草稿', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    preview.current.failNextPlay = true
    const applied = await preview.service.previewDialogueDraft({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '1',
      editRevision: 1,
      text: '未定位草稿'
    })
    expect(applied).toEqual({ status: 'unavailable', reason: 'runtimeNotReady' })
    expect(preview.session(opened.previewSessionId)?.unsavedEdits.get('1')).toEqual({
      dialogueId: '1',
      text: '未定位草稿',
      editRevision: 1
    })
    expect(preview.current.overlays.at(-1)).toBe('未定位草稿\n后面一句')
    expect(preview.writes).toEqual([])
  })

  it('保存后新源缺少草稿正文范围时明确失败且保留草稿', async () => {
    const preview = createPreview()
    const opened = await preview.service.openScenePreview({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    await preview.service.preparePreviewStage({ previewSessionId: opened.previewSessionId })
    await preview.service.previewDialogueDraft({
      previewSessionId: opened.previewSessionId,
      expectedRuntimeGeneration: 1,
      dialogueId: '4',
      text: '无范围草稿',
      editRevision: 2
    })
    const before = preview.current.overlays.slice()
    const release = preview.holdCommit()
    const saving = preview.service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'missing-range',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '1', text: '已保存一句' }]
    })
    await preview.waitForCommitEntry()
    const savedSource = withFileDigest(source(basis.digest, '已保存一句'), 'revision-1')
    savedSource.parsed.sentences[1]!.contentRange = undefined
    preview.current.override = savedSource
    release()
    const saved = await saving
    expect(saved).toMatchObject({
      status: 'saved',
      previewUpdate: {
        status: 'failed',
        failure: { code: 'dialogueObjectInvalid', recovery: 'reopen' }
      }
    })
    expect(preview.session(opened.previewSessionId)?.unsavedEdits.get('4')?.text).toBe('无范围草稿')
    expect(preview.current.overlays).toEqual(before)
  })
})

function candidate(): CandidatePreviewSession {
  return {
    previewSessionId: 'candidate-session',
    projectId: 'project-1',
    sceneId: 'scene-1',
    sceneName: 'start',
    candidateSnapshotId: 'candidate-1',
    projectRoot: 'D:/candidate',
    entryFile: 'game/scene/start.txt',
    metadataFiles: [],
    expiresAt: '2026-10-24T00:15:00.000Z'
  }
}
function withFileDigest(fact: ScenePreviewSourceFact, fileDigest: string): ScenePreviewSourceFact {
  const entry = { ...fact.snapshot.entryFile, digest: fileDigest }
  return {
    ...fact,
    snapshot: { ...fact.snapshot, entryFile: entry, files: [entry] }
  }
}

function divergentSave(fileDigest: string): ScenePreviewApplicationServiceImpl {
  let phase: 'before' | 'after' = 'before'
  const recordBasis = {
    digest: 'collection-after',
    parserVersion: 'parser-1',
    engineVersion: 'engine-1'
  }
  const savedEdits = [{ dialogueId: '1', text: '改后的一句' }]
  const unexpected = async (): Promise<never> => {
    throw new Error('舞台未准备时不应调用运行时')
  }
  const runtime: PreviewRuntimeGateway = {
    prepare: unexpected,
    setSceneTextOverlay: unexpected,
    clearSceneTextOverlay: unexpected,
    playDialogue: unexpected,
    subscribe: () => () => undefined,
    release: async () => undefined
  }
  return new ScenePreviewApplicationServiceImpl({
    artifacts: { readSceneArtifact: async () => ({ status: 'available' }) },
    sources: {
      readScenePreviewSource: async () =>
        phase === 'before'
          ? source('collection-before', '原来的一句')
          : withFileDigest(source('collection-after', '改后的一句'), fileDigest)
    },
    revisions: {
      prepareDialogueRevision: async () => {
        phase = 'after'
        return {
          relativePath: 'game/scene/start.txt',
          bytes: Uint8Array.of(1),
          digest: 'file-bytes'
        }
      }
    },
    versions: {
      commitPreviewSave: async () => ({ status: 'committed', contentBasis: recordBasis }),
      readPreviewSaveSettlement: async (request) =>
        phase === 'before'
          ? { status: 'notFound', request }
          : { status: 'saved', contentBasis: recordBasis, committedEdits: savedEdits },
      recordPreviewSaveRefusal: async () => undefined
    },
    runtime,
    nextId: () => 'preview-divergent'
  })
}

describe('候选预览只读编排', () => {
  it('源不可用只重读一次，失效不交付，问题不泄漏路径', async () => {
    const session = candidate()
    let reads = 0
    let resolves = 0
    const sessions: CandidatePreviewSessionGateway = {
      resolveCandidatePreviewSession: async () => {
        resolves += 1
        return resolves < 3
          ? { status: 'resolved', session }
          : { status: 'rejected', reason: 'expired' }
      }
    }
    const sources: SceneSourceReaderGateway = {
      readSceneSource: async (request) => {
        reads += 1
        expect(request).toMatchObject({
          projectRoot: session.projectRoot,
          entryFile: session.entryFile,
          metadataFiles: []
        })
        if (reads === 1) {
          throw new AppException({ code: ErrorCodes.internalError, msg: 'D:/secret/start.txt' })
        }
        return source().snapshot
      }
    }
    const parser: SceneScriptParserGateway = {
      parseSceneScript: () => ({
        ...source().parsed,
        diagnostics: [{ kind: 'unsupported-command', message: 'D:/secret line 8' }]
      })
    }
    const references: SceneAssetReferenceGateway = {
      checkSceneAssetReferences: async () => [
        {
          rawReference: '../secret.png',
          runtimeReference: '../secret.png',
          kind: 'image',
          status: 'invalid-path',
          sourceLine: 8
        }
      ]
    }
    const compatibility: SceneCompatibilityGateway = {
      readSceneCompatibility: async () => ({ parserVersion: 'parser-1', engineVersion: 'engine-1' })
    }
    const service = new SceneCandidatePreviewApplicationServiceImpl({
      sessions,
      sources,
      parser,
      references,
      compatibility
    })
    await expect(
      service.readCandidatePreview({
        projectId: session.projectId,
        sceneId: session.sceneId,
        previewSessionId: session.previewSessionId
      })
    ).rejects.toMatchObject({ code: ScenePreviewErrorCodes.candidateSessionExpired })
    expect(reads).toBe(2)
    const stable: CandidatePreviewSessionGateway = {
      resolveCandidatePreviewSession: async () => ({ status: 'resolved', session })
    }
    const safe = new SceneCandidatePreviewApplicationServiceImpl({
      sessions: stable,
      sources: { readSceneSource: async () => source().snapshot },
      parser,
      references,
      compatibility
    })
    const result = await safe.readCandidatePreview({
      projectId: session.projectId,
      sceneId: session.sceneId,
      previewSessionId: session.previewSessionId
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|line|\.png/u)
  })
})
