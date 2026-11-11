import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import type { DialogueEditPlan } from '@domain/scene-preview/models/DialogueEditPlan'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import type { PreviewRuntimeGateway } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import { ScenePreviewApplicationServiceImpl } from '@application/scene-preview/services/impl/ScenePreviewApplicationServiceImpl'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { CandidatePreviewSessionGatewayImpl } from '@infrastructure/scene-preview/CandidatePreviewSessionGatewayImpl'
import { previewCallerOperationId } from '@infrastructure/scene-preview/previewSaveIdentity'
import { readPreviewSaveRecord } from '@infrastructure/scene-preview/previewSaveRecord'
import { LocalPreviewSaveVersionGateway } from '@infrastructure/scene-preview/LocalPreviewSaveVersionGateway'
import { LocalSceneDialogueRevisionGateway } from '@infrastructure/scene-preview/LocalSceneDialogueRevisionGateway'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import { LocalScenePreviewSourceGateway } from '@infrastructure/scene-preview/LocalScenePreviewSourceGateway'
import { SceneCompatibilityGatewayImpl } from '@infrastructure/scene-preview/SceneCompatibilityGatewayImpl'
import { ScenePreviewArtifactGatewayImpl } from '@infrastructure/scene-preview/ScenePreviewArtifactGatewayImpl'
import { SceneGenerationContextAssemblerImpl } from '@infrastructure/scene-generation/agents/context/SceneGenerationContextAssemblerImpl'
import type { CandidatePreviewSessionRecord } from '@application/scenes/models/CandidatePreviewSessionRecord'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'

const roots: string[] = []
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const script =
  ['小明:原来的正文 -vocal=voice.ogg -volume=60; 保留注释', '旁白:另一句;'].join('\r\n') + '\r\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('首版预览数据适配', () => {
  it('只改正文、独立提交，并在重建后拒绝重复和冲突', async () => {
    const world = await registeredScene()
    const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
    const sources = new SceneSourceReaderGatewayImpl()
    const parser = new SceneScriptParserGatewayImpl()
    const artifacts = new ScenePreviewArtifactGatewayImpl(locations, sources, parser)
    expect(await artifacts.readSceneArtifact(scene)).toEqual({ status: 'available' })

    const reader = new LocalScenePreviewSourceGateway(
      locations,
      sources,
      parser,
      new SceneAssetReferenceGatewayImpl()
    )
    const source = await reader.readScenePreviewSource(scene)
    expect(source.lockState).toBe('editable')
    expect(source.dialogues[0]).toMatchObject({
      dialogueId: '0',
      text: '原来的正文',
      located: true
    })
    const plan: DialogueEditPlan = {
      scene,
      changedEdits: [{ dialogueId: '0', text: '改后的正文' }],
      unchangedEdits: []
    }
    const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(
      source,
      plan
    )
    const revised = new TextDecoder().decode(revision.bytes)
    expect(revised).toContain('小明:改后的正文 -vocal=voice.ogg -volume=60; 保留注释')
    expect(revised).toContain('\r\n旁白:另一句;\r\n')
    expect(revised).not.toContain('原来的正文')

    const first = gateway(world.userDirectory, ['op-preview-1', 'history-preview-1'])
    const committed = await first.commitPreviewSave({
      ...scene,
      requestId: 'request-1',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify(plan.changedEdits),
      committedEdits: plan.changedEdits,
      revision
    })
    expect(committed.status).toBe('committed')
    if (committed.status !== 'committed') throw new Error('保存没有提交')
    const savedSource = await reader.readScenePreviewSource(scene)
    expect(committed.contentBasis).toEqual(savedSource.contentBasis)
    const repeated = await first.commitPreviewSave({
      ...scene,
      requestId: 'request-1',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify(plan.changedEdits),
      committedEdits: plan.changedEdits,
      revision
    })
    expect(repeated.status).toBe('committed')
    if (repeated.status !== 'committed') throw new Error('重复保存没有复用')
    expect(repeated.contentBasis).toEqual(savedSource.contentBasis)
    expect(commitCount(world.projectRoot)).toBe(2)

    const reloaded = gateway(world.userDirectory, ['unused'])
    const settlement = await reloaded.readPreviewSaveSettlement({
      ...scene,
      requestId: 'request-1',
      editsSnapshot: JSON.stringify(plan.changedEdits)
    })
    expect(settlement).toMatchObject({ status: 'saved', contentBasis: savedSource.contentBasis })
    const conflict = await reloaded.commitPreviewSave({
      ...scene,
      requestId: 'request-1',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify([{ dialogueId: '0', text: '另一份正文' }]),
      committedEdits: [{ dialogueId: '0', text: '另一份正文' }],
      revision
    })
    expect(conflict.status).toBe('rejected')
    expect(commitCount(world.projectRoot)).toBe(2)
  })

  it('保存回退后不能显示已保存，同一请求也不能重放成功', async () => {
    const world = await registeredScene()
    const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
    const reader = new LocalScenePreviewSourceGateway(
      locations,
      new SceneSourceReaderGatewayImpl(),
      new SceneScriptParserGatewayImpl(),
      new SceneAssetReferenceGatewayImpl()
    )
    const source = await reader.readScenePreviewSource(scene)
    const plan: DialogueEditPlan = {
      scene,
      changedEdits: [{ dialogueId: '0', text: '回退后不该留下' }],
      unchangedEdits: []
    }
    const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(
      source,
      plan
    )
    const versioning = versioningService(world.userDirectory, ['op-reverted', 'history-reverted'])
    const saving = new LocalPreviewSaveVersionGateway(world.userDirectory, versioning, reader)
    const committed = await saving.commitPreviewSave({
      ...scene,
      requestId: 'request-reverted',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify(plan.changedEdits),
      committedEdits: plan.changedEdits,
      revision
    })
    expect(committed.status).toBe('committed')
    const link = await versioning.findCallerOperation({
      sourceModule: 'scene-preview',
      callerOperationId: previewCallerOperationId(
        scene.projectId,
        scene.sceneId,
        'request-reverted'
      )
    })
    if (!link) throw new Error('保存没有绑定版本身份')
    await versioning.rollbackOperation({
      projectId: scene.projectId,
      operationId: link.operationId
    })
    const restored = await readFile(join(world.projectRoot, 'game/scene/start.txt'), 'utf8')
    expect(restored).toContain('原来的正文')
    expect(restored).not.toContain('回退后不该留下')
    const settlement = await saving.readPreviewSaveSettlement({
      ...scene,
      requestId: 'request-reverted',
      editsSnapshot: JSON.stringify(plan.changedEdits)
    })
    expect(settlement.status).not.toBe('saved')
    const replay = await saving.commitPreviewSave({
      ...scene,
      requestId: 'request-reverted',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify(plan.changedEdits),
      committedEdits: plan.changedEdits,
      revision
    })
    expect(replay.status).not.toBe('committed')
    expect(await readFile(join(world.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(restored)
  })

  it('同会话连续保存后，重开依据和导出绑定一致', async () => {
    const world = await registeredScene()
    const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
    const reader = new LocalScenePreviewSourceGateway(
      locations,
      new SceneSourceReaderGatewayImpl(),
      new SceneScriptParserGatewayImpl(),
      new SceneAssetReferenceGatewayImpl()
    )
    const versions = gateway(world.userDirectory, [
      'op-save-1',
      'history-save-1',
      'op-save-2',
      'history-save-2',
      'op-spare-1',
      'history-spare-1'
    ])
    const unexpected = async (): Promise<never> => {
      throw new Error('舞台未准备时不应调用运行时')
    }
    const runtime: PreviewRuntimeGateway = {
      prepare: unexpected,
      applyDraftDialogue: unexpected,
      playDialogue: unexpected,
      subscribe: () => () => undefined,
      release: async () => undefined
    }
    const service = new ScenePreviewApplicationServiceImpl({
      artifacts: new ScenePreviewArtifactGatewayImpl(
        locations,
        new SceneSourceReaderGatewayImpl(),
        new SceneScriptParserGatewayImpl()
      ),
      sources: reader,
      revisions: new LocalSceneDialogueRevisionGateway(),
      versions,
      runtime,
      nextId: () => 'preview-live'
    })
    const opened = await service.openScenePreview(scene)
    const firstSave = await service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'request-1',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '0', text: '第一次保存' }]
    })
    expect(firstSave).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    if (firstSave.status !== 'saved') throw new Error('第一次保存没有成功')
    expect(firstSave.contentBasis).not.toEqual(opened.contentBasis)
    const secondSave = await service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'request-2',
      baseContentBasis: firstSave.contentBasis,
      edits: [{ dialogueId: '0', text: '第二次保存' }]
    })
    expect(secondSave).toMatchObject({
      status: 'saved',
      previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
    })
    if (secondSave.status !== 'saved') throw new Error('第二次保存没有成功')
    expect(secondSave.contentBasis).not.toEqual(firstSave.contentBasis)
    const replay = await service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'request-2',
      baseContentBasis: firstSave.contentBasis,
      edits: [{ dialogueId: '0', text: '第二次保存' }]
    })
    expect(replay).toMatchObject({ status: 'saved', contentBasis: secondSave.contentBasis })
    await expect(
      service.saveDialogueChanges({
        previewSessionId: opened.previewSessionId,
        requestId: 'request-2',
        baseContentBasis: firstSave.contentBasis,
        edits: [{ dialogueId: '0', text: '另一份正文' }]
      })
    ).rejects.toMatchObject({ cause: 'saveRequestReused' })
    expect(commitCount(world.projectRoot)).toBe(3)
    await service.closeScenePreview({ previewSessionId: opened.previewSessionId })
    const reopened = await service.openScenePreview(scene)
    expect(reopened.contentBasis).toEqual(secondSave.contentBasis)
    const text = await readFile(join(world.projectRoot, 'game/scene/start.txt'), 'utf8')
    expect(text).toContain('小明:第二次保存 -vocal=voice.ogg -volume=60; 保留注释')
    expect(text).not.toContain('第一次保存')
    const exporting = new LocalSceneExportSourceGateway(
      world.userDirectory,
      new ProjectVersioningApplicationServiceImpl({
        ...createProjectVersioningGateways(world.userDirectory),
        nextId: () => 'op-export-read'
      }),
      reader
    )
    const exported = await exporting.readSavedScene({
      ...scene,
      contentBasis: reopened.contentBasis,
      versionReference: { kind: 'preview-save', requestId: 'request-2' }
    })
    expect(exported.sceneText).toContain('第二次保存')
    await expect(
      exporting.readSavedScene({
        ...scene,
        contentBasis: firstSave.contentBasis,
        versionReference: { kind: 'preview-save', requestId: 'request-1' }
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.savedContentMismatch })
    await expect(
      exporting.readSavedScene({
        ...scene,
        contentBasis: opened.contentBasis,
        versionReference: { kind: 'preview-save', requestId: 'request-2' }
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.savedContentMismatch })
    const rebuilt = gateway(world.userDirectory, ['unused'])
    await expect(
      rebuilt.readPreviewSaveSettlement({
        ...scene,
        requestId: 'request-1',
        editsSnapshot: JSON.stringify([{ dialogueId: '0', text: '第一次保存' }])
      })
    ).resolves.toMatchObject({ status: 'saved', contentBasis: firstSave.contentBasis })
    await expect(
      rebuilt.readPreviewSaveSettlement({
        ...scene,
        requestId: 'request-2',
        editsSnapshot: JSON.stringify([{ dialogueId: '0', text: '第二次保存' }])
      })
    ).resolves.toMatchObject({ status: 'saved', contentBasis: reopened.contentBasis })
  })

  it('同一音频按说明同时作 BGM 和音效，预览与导出解析同一来源', async () => {
    const audioSourceId = '1f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b'
    const audioKey = encodeStorageKey(audioSourceId)
    const audioPath = `assets/${audioKey}/duck.ogg`
    const audioBytes = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x01, 0x02, 0x03)
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'generate',
        execution: {
          projectId: scene.projectId,
          sceneId: scene.sceneId,
          source: { sceneDirectory: 'game/scene', entryFile: 'start.txt' },
          inputSnapshot: {
            assets: [
              {
                assetId: 'card-audio',
                sourceId: audioSourceId,
                name: '下压音',
                relativePath: audioPath,
                category: 'audio',
                description: '下压音效',
                usage: { targetIds: [] }
              }
            ]
          },
          candidateSnapshotId: 'revision',
          budget: {},
          replies: []
        } as SceneGenerationExecution
      })
    ) as {
      assetBindings: {
        category: string
        commandReference: string
      }[]
    }
    const cue = assembled.assetBindings[0]?.commandReference
    expect(assembled.assetBindings[0]).toMatchObject({
      category: 'audio',
      commandReference: `${audioKey}/duck.ogg`
    })
    expect(assembled.assetBindings[0]).not.toHaveProperty('defaultRuntimeDirectory')
    expect(assembled.assetBindings[0]).not.toHaveProperty('purpose')
    if (cue === undefined) throw new Error('绑定缺少命令引用')

    const world = await registeredScene({
      script:
        ['小明:开始;', `bgm:${cue};`, `playEffect:${cue};`, '旁白:结束;'].join('\r\n') + '\r\n',
      audioPath,
      audioBytes
    })
    const reader = new LocalScenePreviewSourceGateway(
      new RegisteredSceneLocationGatewayImpl(world.userDirectory),
      new SceneSourceReaderGatewayImpl(),
      new SceneScriptParserGatewayImpl(),
      new SceneAssetReferenceGatewayImpl()
    )
    const source = await reader.readScenePreviewSource(scene)
    const background = source.references.find((reference) => reference.kind === 'bgm')
    const effect = source.references.find((reference) => reference.kind === 'vocal')
    expect(background).toMatchObject({
      rawReference: cue,
      runtimeReference: `./game/bgm/${cue}`,
      relativePath: audioPath,
      status: 'present'
    })
    expect(effect).toMatchObject({
      rawReference: cue,
      runtimeReference: `./game/vocal/${cue}`,
      relativePath: audioPath,
      status: 'present'
    })

    const plan: DialogueEditPlan = {
      scene,
      changedEdits: [{ dialogueId: '0', text: '开始（改）' }],
      unchangedEdits: []
    }
    const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(
      source,
      plan
    )
    const versions = gateway(world.userDirectory, ['op-audio-1', 'history-audio-1'])
    const committed = await versions.commitPreviewSave({
      ...scene,
      requestId: 'request-audio',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify(plan.changedEdits),
      committedEdits: plan.changedEdits,
      revision
    })
    expect(committed.status).toBe('committed')
    if (committed.status !== 'committed') throw new Error('音频场景没有提交')
    const saved = await reader.readScenePreviewSource(scene)
    const exporting = new LocalSceneExportSourceGateway(
      world.userDirectory,
      versioningService(world.userDirectory, ['op-export-audio']),
      reader
    )
    const exported = await exporting.readSavedScene({
      ...scene,
      contentBasis: saved.contentBasis,
      versionReference: { kind: 'preview-save', requestId: 'request-audio' }
    })
    expect(exported.sceneText).toContain(`bgm:${cue}`)
    expect(exported.sceneText).toContain(`playEffect:${cue}`)
    expect(exported.referencedAssets).toEqual([
      { sourcePath: audioPath, packagePath: `game/bgm/${cue}` },
      { sourcePath: audioPath, packagePath: `game/vocal/${cue}` }
    ])
    await expect(readFile(join(world.projectRoot, 'game/bgm', cue))).rejects.toThrow()
    await expect(readFile(join(world.projectRoot, 'game/vocal', cue))).rejects.toThrow()
    expect(await readFile(join(world.projectRoot, audioPath))).toEqual(Buffer.from(audioBytes))
  })

  it('提交时锁定或正文不能写回时返回确定拒绝，持久层未知仍待核对', async () => {
    const world = await registeredScene()
    const locations = new RegisteredSceneLocationGatewayImpl(world.userDirectory)
    const reader = new LocalScenePreviewSourceGateway(
      locations,
      new SceneSourceReaderGatewayImpl(),
      new SceneScriptParserGatewayImpl(),
      new SceneAssetReferenceGatewayImpl()
    )
    const versions = gateway(world.userDirectory, ['op-range-1', 'history-range-1'])
    const runtime: PreviewRuntimeGateway = {
      prepare: unexpectedRuntime,
      applyDraftDialogue: unexpectedRuntime,
      playDialogue: unexpectedRuntime,
      subscribe: () => () => undefined,
      release: async () => undefined
    }
    const service = new ScenePreviewApplicationServiceImpl({
      artifacts: new ScenePreviewArtifactGatewayImpl(
        locations,
        new SceneSourceReaderGatewayImpl(),
        new SceneScriptParserGatewayImpl()
      ),
      sources: reader,
      revisions: new LocalSceneDialogueRevisionGateway(),
      versions,
      runtime,
      nextId: () => 'preview-error'
    })
    const before = commitCount(world.projectRoot)
    const versioning = new ProjectVersioningApplicationServiceImpl({
      ...createProjectVersioningGateways(world.userDirectory),
      nextId: () => {
        const next = ['op-lock-1', 'history-lock-1'].shift()
        if (!next) throw new Error('锁定测试身份已用尽')
        return next
      }
    })
    const commitOperation = versioning.commitOperation.bind(versioning)
    vi.spyOn(versioning, 'commitOperation').mockImplementation(
      async (request, requirePreconditions) => {
        return commitOperation(request, async () => {
          await writeFile(
            join(world.projectRoot, '.opengalgame/scene-locks.json'),
            JSON.stringify({
              scenes: [{ sceneId: scene.sceneId, lockState: 'locked' }]
            })
          )
          await requirePreconditions()
        })
      }
    )
    const lockedGateway = new LocalPreviewSaveVersionGateway(
      world.userDirectory,
      versioning,
      reader
    )
    const source = await reader.readScenePreviewSource(scene)
    const plan: DialogueEditPlan = {
      scene,
      changedEdits: [{ dialogueId: '0', text: '锁定后的正文' }],
      unchangedEdits: []
    }
    const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(
      source,
      plan
    )
    const locked = await lockedGateway.commitPreviewSave({
      ...scene,
      requestId: 'request-locked',
      baseContentBasis: source.contentBasis,
      editsSnapshot: JSON.stringify(plan.changedEdits),
      committedEdits: plan.changedEdits,
      revision
    })
    expect(locked).toMatchObject({ status: 'rejected', failure: { code: 'contentLocked' } })
    expect(commitCount(world.projectRoot)).toBe(before)
    await expect(
      lockedGateway.readPreviewSaveSettlement({
        ...scene,
        requestId: 'request-locked',
        editsSnapshot: JSON.stringify(plan.changedEdits)
      })
    ).resolves.toMatchObject({ status: 'conflict', failure: { code: 'contentLocked' } })
    await writeFile(
      join(world.projectRoot, '.opengalgame/scene-locks.json'),
      `${JSON.stringify({ scenes: [{ sceneId: scene.sceneId, lockState: 'unlocked' }] })}\n`
    )
    const opened = await service.openScenePreview(scene)

    const unlocated = structuredClone(await reader.readScenePreviewSource(scene))
    const target = unlocated.parsed.sentences.find((sentence) => sentence.sequence === 0)
    if (!target) throw new Error('测试台词不存在')
    target.contentRange = undefined
    const readSource = vi.spyOn(reader, 'readScenePreviewSource').mockResolvedValue(unlocated)
    const missingRange = await service.saveDialogueChanges({
      previewSessionId: opened.previewSessionId,
      requestId: 'request-range',
      baseContentBasis: opened.contentBasis,
      edits: [{ dialogueId: '0', text: '缺少范围的正文' }]
    })
    readSource.mockRestore()
    expect(missingRange).toMatchObject({
      status: 'rejected',
      failure: { code: 'dialogueObjectInvalid' }
    })
    expect(commitCount(world.projectRoot)).toBe(before)
    await expect(
      service.readDialogueSaveSettlement({
        ...scene,
        requestId: 'request-range'
      })
    ).resolves.toMatchObject({ status: 'conflict', failure: { code: 'dialogueObjectInvalid' } })
    await service.closeScenePreview({ previewSessionId: opened.previewSessionId })
    const text = await readFile(join(world.projectRoot, 'game/scene/start.txt'), 'utf8')
    expect(text).toContain('原来的正文')
    expect(text).not.toContain('锁定后的正文')
    expect(text).not.toContain('缺少范围的正文')

    const unknownVersioning = new ProjectVersioningApplicationServiceImpl({
      ...createProjectVersioningGateways(world.userDirectory),
      nextId: () => 'op-unused'
    })
    vi.spyOn(unknownVersioning, 'prepareOperation').mockRejectedValue(
      new AppException({
        code: ProjectVersioningErrorCodes.insufficientEvidence,
        msg: '提交结果不明，不能重试'
      })
    )
    const fresh = await reader.readScenePreviewSource(scene)
    const unknownGateway = new LocalPreviewSaveVersionGateway(
      world.userDirectory,
      unknownVersioning,
      reader
    )
    const unknownPlan: DialogueEditPlan = {
      scene,
      changedEdits: [{ dialogueId: '0', text: '结果未知的正文' }],
      unchangedEdits: []
    }
    const unknownRevision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(
      fresh,
      unknownPlan
    )
    const unknown = await unknownGateway.commitPreviewSave({
      ...scene,
      requestId: 'request-unknown',
      baseContentBasis: fresh.contentBasis,
      editsSnapshot: JSON.stringify(unknownPlan.changedEdits),
      committedEdits: unknownPlan.changedEdits,
      revision: unknownRevision
    })
    expect(unknown).toMatchObject({ status: 'pendingVerification' })
    await expect(
      unknownGateway.readPreviewSaveSettlement({
        ...scene,
        requestId: 'request-unknown'
      })
    ).resolves.toMatchObject({ status: 'notFound' })
    expect(commitCount(world.projectRoot)).toBe(before)
  })
  it('候选过期或错属时不读取文件，兼容性只返回固定版本', async () => {
    const secret = join(tmpdir(), 'candidate-secret.txt')
    let reads = 0
    const lookup = {
      findCandidatePreviewSession(id: string): CandidatePreviewSessionRecord | undefined {
        reads += 1
        if (id === 'missing') return undefined
        return {
          previewSessionId: id,
          projectId: 'project-1',
          sceneId: 'scene-1',
          sceneName: 'start',
          candidateSnapshotId: 'candidate-1',
          projectRoot: secret,
          entryFile: 'game/scene/start.txt',
          metadataFiles: [],
          expiresAt: new Date(1_000).toISOString(),
          state: id === 'expired' ? 'expired' : 'active'
        }
      }
    }
    const sessions = new CandidatePreviewSessionGatewayImpl(lookup, () => 2_000)
    expect(
      await sessions.resolveCandidatePreviewSession({ ...scene, previewSessionId: 'expired' })
    ).toEqual({
      status: 'rejected',
      reason: 'expired'
    })
    expect(
      await sessions.resolveCandidatePreviewSession({
        projectId: 'other-project',
        sceneId: 'scene-1',
        previewSessionId: 'active'
      })
    ).toEqual({ status: 'rejected', reason: 'mismatch' })
    expect(reads).toBe(2)
    await expect(readFile(secret)).rejects.toThrow()
    const compatibility = await new SceneCompatibilityGatewayImpl().readSceneCompatibility()
    expect(compatibility).toEqual({ parserVersion: '4.6.5', engineVersion: '4.6.5' })
  })

  it('确认失败但已提交时，结算查询补回内容依据并返回已保存', async () => {
    const world = await registeredScene()
    const pendingSave = await savingPendingConfirmation(world, {
      ids: ['op-settle-1', 'history-settle-1'],
      requestId: 'request-settle-1',
      text: '补记的正文'
    })
    const settlement = await pendingSave.saving.readPreviewSaveSettlement({
      ...scene,
      requestId: 'request-settle-1',
      editsSnapshot: pendingSave.editsSnapshot
    })
    expect(settlement).toMatchObject({ status: 'saved' })
    if (settlement.status !== 'saved') throw new Error('结算没有补回保存状态')
    const current = await pendingSave.reader.readScenePreviewSource(scene)
    expect(settlement.contentBasis).toEqual(current.contentBasis)
    const callerOperationId = previewCallerOperationId(
      scene.projectId,
      scene.sceneId,
      'request-settle-1'
    )
    const record = await readPreviewSaveRecord(world.projectRoot, callerOperationId)
    expect(record?.contentDigest).toBe(settlement.contentBasis.digest)
    const repeated = await pendingSave.saving.readPreviewSaveSettlement({
      ...scene,
      requestId: 'request-settle-1',
      editsSnapshot: pendingSave.editsSnapshot
    })
    expect(repeated).toEqual(settlement)
    const exporting = new LocalSceneExportSourceGateway(
      world.userDirectory,
      versioningService(world.userDirectory, ['op-export-settle']),
      pendingSave.reader
    )
    const exported = await exporting.readSavedScene({
      ...scene,
      contentBasis: settlement.contentBasis,
      versionReference: { kind: 'preview-save', requestId: 'request-settle-1' }
    })
    expect(exported.sceneText).toContain('补记的正文')
  })

  it('场景文件与保存修订不一致时返回冲突且不补写内容依据', async () => {
    const world = await registeredScene()
    const pendingSave = await savingPendingConfirmation(world, {
      ids: ['op-settle-2', 'history-settle-2'],
      requestId: 'request-settle-2',
      text: '不该被认领的正文'
    })
    await writeFile(
      join(world.projectRoot, 'game/scene/start.txt'),
      '小明:被改后的正文 -vocal=voice.ogg -volume=60;\r\n'
    )
    const settlement = await pendingSave.saving.readPreviewSaveSettlement({
      ...scene,
      requestId: 'request-settle-2',
      editsSnapshot: pendingSave.editsSnapshot
    })
    expect(settlement).toMatchObject({
      status: 'conflict',
      failure: { code: 'saveSettlementConflict' }
    })
    const record = await readPreviewSaveRecord(
      world.projectRoot,
      previewCallerOperationId(scene.projectId, scene.sceneId, 'request-settle-2')
    )
    expect(record?.contentDigest).toBeUndefined()
  })

  it('结算补读失败时保持待核对且不补写内容依据', async () => {
    const world = await registeredScene()
    const pendingSave = await savingPendingConfirmation(world, {
      ids: ['op-settle-3', 'history-settle-3'],
      requestId: 'request-settle-3',
      text: '读取失败时的正文'
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const readFailure = vi
        .spyOn(pendingSave.reader, 'readScenePreviewSource')
        .mockRejectedValue(new Error('读取失败'))
      try {
        const settlement = await pendingSave.saving.readPreviewSaveSettlement({
          ...scene,
          requestId: 'request-settle-3',
          editsSnapshot: pendingSave.editsSnapshot
        })
        expect(settlement).toMatchObject({ status: 'pendingVerification' })
      } finally {
        readFailure.mockRestore()
      }
      expect(warning).toHaveBeenCalled()
      const record = await readPreviewSaveRecord(
        world.projectRoot,
        previewCallerOperationId(scene.projectId, scene.sceneId, 'request-settle-3')
      )
      expect(record?.contentDigest).toBeUndefined()
    } finally {
      warning.mockRestore()
    }
  })
})

async function registeredScene(
  options: { script?: string; audioPath?: string; audioBytes?: Uint8Array } = {}
): Promise<{ userDirectory: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'preview-data-'))
  roots.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame/canvases', encodeStorageKey(scene.sceneId)), {
    recursive: true
  })
  await writeFile(
    join(projectRoot, '.opengalgame/project.json'),
    JSON.stringify({
      id: scene.projectId,
      name: '预览工程',
      synopsis: ''
    })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    JSON.stringify({
      formatVersion: 2,
      projectId: scene.projectId,
      operationId: 'op-register'
    })
  )
  await writeFile(join(projectRoot, 'game/scene/start.txt'), options.script ?? script)
  await mkdir(join(projectRoot, 'game/vocal'), { recursive: true })
  await writeFile(join(projectRoot, 'game/vocal/voice.ogg'), Uint8Array.of(1))
  if (options.audioPath) {
    await mkdir(dirname(join(projectRoot, options.audioPath)), { recursive: true })
    await writeFile(join(projectRoot, options.audioPath), options.audioBytes ?? Uint8Array.of())
  }
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    JSON.stringify({
      scenes: [{ sceneId: scene.sceneId, lockState: 'unlocked' }]
    })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/canvases', encodeStorageKey(scene.sceneId), 'canvas.json'),
    '{}'
  )
  await writeProjectRegistrations(userDirectory, [
    { id: scene.projectId, directory: projectRoot, operationId: 'op-register' }
  ])
  execFileSync('git', ['init'], { cwd: projectRoot })
  await createProjectVersioningGateways(userDirectory).transactions.initializeBaseline({
    projectId: scene.projectId,
    initialPaths: [
      'game/scene/start.txt',
      'game/vocal/voice.ogg',
      ...(options.audioPath ? [options.audioPath] : []),
      '.opengalgame/scene-locks.json',
      '.opengalgame/project.json'
    ]
  })
  return { userDirectory, projectRoot }
}

function versioningService(
  userDirectory: string,
  ids: readonly string[]
): ProjectVersioningApplicationServiceImpl {
  const remaining = [...ids]
  return new ProjectVersioningApplicationServiceImpl({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => {
      const next = remaining.shift()
      if (!next) throw new Error('测试身份已用尽')
      return next
    }
  })
}

function gateway(userDirectory: string, ids: readonly string[]): LocalPreviewSaveVersionGateway {
  const versioning = versioningService(userDirectory, ids)
  const reader = previewReader(userDirectory)
  return new LocalPreviewSaveVersionGateway(userDirectory, versioning, reader)
}

function previewReader(userDirectory: string): LocalScenePreviewSourceGateway {
  return new LocalScenePreviewSourceGateway(
    new RegisteredSceneLocationGatewayImpl(userDirectory),
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
}

interface PendingSaveSetup {
  readonly saving: LocalPreviewSaveVersionGateway
  readonly reader: LocalScenePreviewSourceGateway
  readonly contentBasis: SceneContentBasisVO
  readonly editsSnapshot: string
}

/**
 * 提交一次保存，并让提交后的确认读取失败，模拟记录缺少 contentDigest 而 git 已提交的结算死结。
 */
async function savingPendingConfirmation(
  world: { userDirectory: string; projectRoot: string },
  options: { ids: readonly string[]; requestId: string; text: string }
): Promise<PendingSaveSetup> {
  const reader = previewReader(world.userDirectory)
  const source = await reader.readScenePreviewSource(scene)
  const plan: DialogueEditPlan = {
    scene,
    changedEdits: [{ dialogueId: '0', text: options.text }],
    unchangedEdits: []
  }
  const editsSnapshot = JSON.stringify(plan.changedEdits)
  const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(
    source,
    plan
  )
  const saving = new LocalPreviewSaveVersionGateway(
    world.userDirectory,
    versioningService(world.userDirectory, options.ids),
    reader
  )
  const confirmFailure = vi
    .spyOn(reader, 'readScenePreviewSource')
    .mockRejectedValueOnce(new Error('确认读取失败'))
  const committed = await saving.commitPreviewSave({
    ...scene,
    requestId: options.requestId,
    baseContentBasis: source.contentBasis,
    editsSnapshot,
    committedEdits: plan.changedEdits,
    revision
  })
  confirmFailure.mockRestore()
  expect(committed).toEqual({ status: 'pendingVerification' })
  const record = await readPreviewSaveRecord(
    world.projectRoot,
    previewCallerOperationId(scene.projectId, scene.sceneId, options.requestId)
  )
  expect(record?.contentDigest).toBeUndefined()
  return { saving, reader, contentBasis: source.contentBasis, editsSnapshot }
}

function unexpectedRuntime(): Promise<never> {
  return Promise.reject(new Error('舞台未准备时不应调用运行时'))
}

function commitCount(projectRoot: string): number {
  return execFileSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8'
  }).trim() === '2'
    ? 2
    : Number(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], {
          cwd: projectRoot,
          encoding: 'utf8'
        }).trim()
      )
}
