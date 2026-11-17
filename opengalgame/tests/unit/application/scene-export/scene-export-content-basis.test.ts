import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { ReadLatestPreviewSaveUseCase } from '@application/scene-export/services/ReadLatestPreviewSaveUseCase'
import { ExportSavedScene } from '@application/scene-export/services/impl/ExportSavedScene'
import type { SavedSceneExportSource } from '@application/scene-export/ports/SceneExportSourceGateway'
import type { WindowsScenePackager } from '@application/scene-export/ports/WindowsScenePackager'
import type { ScenePreviewSourceFact } from '@application/scene-preview/models/ScenePreviewSourceFact'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { LocalPreviewSaveVersionQueryGateway } from '@infrastructure/scene-export/LocalPreviewSaveVersionQueryGateway'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import { LocalScenePreviewSourceGateway } from '@infrastructure/scene-preview/LocalScenePreviewSourceGateway'
import { previewCallerOperationId } from '@infrastructure/scene-preview/previewSaveIdentity'
import {
  writePreviewSaveRecord,
  type PreviewSaveRecord
} from '@infrastructure/scene-preview/previewSaveRecord'
import {
  parseLatestPreviewSaveResult,
  parseSceneExportResult
} from '@interfaces/scene-export/contracts/SceneExportResponseSchema'

const projectId = 'project-r16'
const sceneId = 'scene-r16'
const requestId = 'request-r16'
const operationId = 'op-r16-save'
const entryRelativePath = 'game/scene/start.txt'
const script = '小明:第一句;\r\n旁白:第二句;\r\n'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface PreparedExport {
  readonly userDirectory: string
  readonly projectRoot: string
  readonly reader: LocalScenePreviewSourceGateway
  readonly preview: ScenePreviewSourceFact
  readonly record: PreviewSaveRecord
  readonly versioning: ProjectVersioningApplicationService
}

interface PreparedOptions {
  readonly parserVersion?: string
  readonly engineVersion?: string
  readonly contentDigest?: string | null
}

/** 落盘一个已登记的正式工程，并写入该场景的预览保存记录。 */
async function preparedExport(options: PreparedOptions = {}): Promise<PreparedExport> {
  const root = await mkdtemp(join(tmpdir(), 'scene-export-content-basis-'))
  roots.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(projectRoot)
  await mkdir(join(projectRoot, '.git'))
  await mkdir(join(projectRoot, '.opengalgame/canvases', encodeStorageKey(sceneId)), {
    recursive: true
  })
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame/project.json'),
    JSON.stringify({ id: projectId, name: '导出依据工程', synopsis: '' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId, operationId: 'op-register' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    JSON.stringify({ scenes: [{ sceneId, lockState: 'unlocked' }] })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/canvases', encodeStorageKey(sceneId), 'canvas.json'),
    '{}'
  )
  await writeFile(join(projectRoot, entryRelativePath), script, 'utf8')
  await writeProjectRegistrations(userDirectory, [
    { id: projectId, directory: projectRoot, operationId: 'op-register' }
  ])

  const reader = new LocalScenePreviewSourceGateway(
    new RegisteredSceneLocationGatewayImpl(userDirectory),
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
  const preview = await reader.readScenePreviewSource({ projectId, sceneId })
  const revisionBytes = await readFile(join(projectRoot, entryRelativePath))
  const record: PreviewSaveRecord = {
    formatVersion: 1,
    projectId,
    sceneId,
    requestId,
    callerOperationId: previewCallerOperationId(projectId, sceneId, requestId),
    operationId,
    baseDigest: preview.contentBasis.digest,
    parserVersion: options.parserVersion ?? preview.contentBasis.parserVersion,
    engineVersion: options.engineVersion ?? preview.contentBasis.engineVersion,
    editsSnapshot: JSON.stringify([{ dialogueId: '0', text: '第一句' }]),
    committedEdits: [{ dialogueId: '0', text: '第一句' }],
    relativePath: entryRelativePath,
    revisionDigest: createHash('sha256').update(revisionBytes).digest('hex'),
    ...(options.contentDigest === null
      ? {}
      : { contentDigest: options.contentDigest ?? preview.contentBasis.digest })
  }
  await writePreviewSaveRecord(projectRoot, record)
  return { userDirectory, projectRoot, reader, preview, record, versioning: settledVersioning(record) }
}

/** 只替换已结算边界；保存记录、工程文件和查询目录都走真实文件系统。 */
function settledVersioning(record: PreviewSaveRecord): ProjectVersioningApplicationService {
  return {
    findCallerOperation: vi.fn(
      async (request: { sourceModule: string; callerOperationId: string }) => {
        if (request.callerOperationId !== record.callerOperationId) return null
        return {
          projectId: record.projectId,
          sourceModule: request.sourceModule,
          callerOperationId: record.callerOperationId,
          operationId: record.operationId
        }
      }
    ),
    readOperationSettlement: vi.fn(async (request: { operationId: string }) => {
      if (request.operationId !== record.operationId) {
        return { operationId: request.operationId, state: '待核对' as const }
      }
      return {
        operationId: request.operationId,
        state: '已提交' as const,
        revisionRef: 'revision-r16'
      }
    })
  } as unknown as ProjectVersioningApplicationService
}

async function latestSave(prepared: PreparedExport): Promise<{
  requestId: string
  revisionDigest: string
  contentBasis: { digest: string; parserVersion: string; engineVersion: string }
}> {
  const useCase = new ReadLatestPreviewSaveUseCase(
    new LocalPreviewSaveVersionQueryGateway(prepared.userDirectory, prepared.versioning)
  )
  const latest = await useCase.readLatestPreviewSave({ projectId, sceneId })
  if (!latest) throw new Error('测试夹具没有已结算的预览保存')
  return latest
}

function exportRequest(basis: {
  digest: string
  parserVersion: string
  engineVersion: string
}): {
  projectId: string
  sceneId: string
  contentBasis: { digest: string; parserVersion: string; engineVersion: string }
  versionReference: { kind: 'preview-save'; requestId: string }
} {
  return {
    projectId,
    sceneId,
    contentBasis: basis,
    versionReference: { kind: 'preview-save', requestId }
  }
}

describe('导出内容依据的保存记录消费', () => {
  it('保存查询按落盘记录生成固定的 contentBasis 形状与 wire 序列化', async () => {
    const prepared = await preparedExport({
      parserVersion: 'parser-r16-pin',
      engineVersion: 'engine-r16-pin'
    })
    const gateway = new LocalPreviewSaveVersionQueryGateway(
      prepared.userDirectory,
      prepared.versioning
    )
    const candidates = await gateway.listSettledPreviewSaves({ projectId, sceneId })
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.contentBasis).toEqual({
      digest: prepared.preview.contentBasis.digest,
      parserVersion: 'parser-r16-pin',
      engineVersion: 'engine-r16-pin'
    })
    expect(Object.keys(candidate.contentBasis).sort()).toEqual([
      'digest',
      'engineVersion',
      'parserVersion'
    ])
    expect(JSON.parse(JSON.stringify(candidate.contentBasis))).toEqual({
      digest: prepared.preview.contentBasis.digest,
      parserVersion: 'parser-r16-pin',
      engineVersion: 'engine-r16-pin'
    })

    const latest = await latestSave(prepared)
    expect(latest).toEqual({
      requestId,
      revisionDigest: prepared.record.revisionDigest,
      contentBasis: {
        digest: prepared.preview.contentBasis.digest,
        parserVersion: 'parser-r16-pin',
        engineVersion: 'engine-r16-pin'
      }
    })
    const wire = parseLatestPreviewSaveResult(
      JSON.parse(
        JSON.stringify({
          code: ErrorCodes.success,
          msg: '读取成功',
          data: latest
        })
      )
    )
    expect(wire).toEqual({
      code: ErrorCodes.success,
      msg: '读取成功',
      data: {
        requestId,
        revisionDigest: prepared.record.revisionDigest,
        contentBasis: {
          digest: prepared.preview.contentBasis.digest,
          parserVersion: 'parser-r16-pin',
          engineVersion: 'engine-r16-pin'
        }
      }
    })
  })

  it('导出边界消费同一条已结算保存记录，结果与 wire 中的 contentBasis 不变', async () => {
    const prepared = await preparedExport()
    const latest = await latestSave(prepared)
    const expectedBasis = {
      digest: prepared.preview.contentBasis.digest,
      parserVersion: '4.6.5',
      engineVersion: '4.6.5'
    }
    expect(latest.contentBasis).toEqual(expectedBasis)
    const sourceGateway = new LocalSceneExportSourceGateway(
      prepared.userDirectory,
      prepared.versioning,
      prepared.reader
    )
    const request = exportRequest(latest.contentBasis)
    const source = await sourceGateway.readSavedScene(request)
    expect(source.contentBasis).toEqual(expectedBasis)
    expect(Object.keys(source.contentBasis).sort()).toEqual([
      'digest',
      'engineVersion',
      'parserVersion'
    ])
    expect(JSON.parse(JSON.stringify(source.contentBasis))).toEqual(expectedBasis)
    expect(source.entryRelativePath).toBe(entryRelativePath)
    expect(source.sceneText).toBe(script)

    let packaged: SavedSceneExportSource | null = null
    const packager: WindowsScenePackager = {
      async packageWindowsScene(input) {
        packaged = input
        return {
          status: 'succeeded',
          artifact: {
            executableName: 'WebGAL.exe',
            directoryName: 'scene-r16',
            directoryPath: 'D:/opengalgame/exports/scene-r16',
            bytes: 128,
            containsFixedEngine: true,
            entryRelativePath: input.entryRelativePath,
            contentBasis: input.contentBasis,
            versionReference: input.versionReference
          }
        }
      }
    }
    const service = new ExportSavedScene({
      sources: sourceGateway,
      packager
    })
    const result = await service.exportSavedScene(request)
    expect(result.status).toBe('succeeded')
    if (result.status !== 'succeeded') throw new Error('导出没有成功')
    expect(packaged!.contentBasis).toEqual(expectedBasis)
    expect(result.artifact.contentBasis).toEqual(expectedBasis)
    expect(Object.keys(result.artifact.contentBasis).sort()).toEqual([
      'digest',
      'engineVersion',
      'parserVersion'
    ])
    expect(JSON.parse(JSON.stringify(result.artifact.contentBasis))).toEqual(expectedBasis)
    const wire = parseSceneExportResult(
      JSON.parse(
        JSON.stringify({
          code: ErrorCodes.success,
          msg: '导出成功',
          data: result
        })
      )
    )
    expect(wire).toMatchObject({
      code: ErrorCodes.success,
      msg: '导出成功',
      data: { status: 'succeeded', artifact: { contentBasis: expectedBasis } }
    })
  })

  it.each([
    ['digest', { digest: '0'.repeat(64) }],
    ['parserVersion', { parserVersion: '4.6.5-other' }],
    ['engineVersion', { engineVersion: '4.6.5-other' }]
  ])('请求 contentBasis 的 %s 与保存记录不一致时拒绝导出', async (_field, patch) => {
    const prepared = await preparedExport()
    const latest = await latestSave(prepared)
    const sourceGateway = new LocalSceneExportSourceGateway(
      prepared.userDirectory,
      prepared.versioning,
      prepared.reader
    )
    const request = exportRequest({ ...latest.contentBasis, ...patch })
    await expect(sourceGateway.readSavedScene(request)).rejects.toMatchObject({
      code: SceneExportErrorCodes.savedContentMismatch
    })
  })

  it('已结算但保存记录没有内容摘要时不产生导出依据', async () => {
    const prepared = await preparedExport({ contentDigest: null })
    const gateway = new LocalPreviewSaveVersionQueryGateway(
      prepared.userDirectory,
      prepared.versioning
    )
    await expect(gateway.listSettledPreviewSaves({ projectId, sceneId })).resolves.toEqual([])
    await expect(
      new ReadLatestPreviewSaveUseCase(gateway).readLatestPreviewSave({ projectId, sceneId })
    ).resolves.toBeNull()
    const sourceGateway = new LocalSceneExportSourceGateway(
      prepared.userDirectory,
      prepared.versioning,
      prepared.reader
    )
    await expect(
      sourceGateway.readSavedScene(exportRequest(prepared.preview.contentBasis))
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.saveNotCommitted })
  })

  it('场景正文落盘后发生变化时，旧保存依据不能再导出', async () => {
    const prepared = await preparedExport()
    const latest = await latestSave(prepared)
    await writeFile(join(prepared.projectRoot, entryRelativePath), '小明:第三句;\r\n', 'utf8')
    const sourceGateway = new LocalSceneExportSourceGateway(
      prepared.userDirectory,
      prepared.versioning,
      prepared.reader
    )
    await expect(sourceGateway.readSavedScene(exportRequest(latest.contentBasis))).rejects.toMatchObject(
      { code: SceneExportErrorCodes.savedContentMismatch }
    )
  })

  it('内容依据出现额外 wire 字段时拒绝导出请求且不读取保存内容', async () => {
    const prepared = await preparedExport()
    const latest = await latestSave(prepared)
    const readSavedScene = vi.fn(async () => {
      throw new Error('输入被拒绝时不应读取保存内容')
    })
    const service = new ExportSavedScene({
      sources: { readSavedScene },
      packager: {
        async packageWindowsScene() {
          throw new Error('输入被拒绝时不应打包')
        }
      }
    })
    await expect(
      service.exportSavedScene(
        exportRequest({ ...latest.contentBasis, extra: 'not-on-the-wire' } as never)
      )
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
    expect(readSavedScene).not.toHaveBeenCalled()
  })
})
