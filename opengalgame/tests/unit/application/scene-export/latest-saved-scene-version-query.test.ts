import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import type { ScenePreviewSourceFact } from '@application/scene-preview/models/ScenePreviewSourceFact'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import { ReadLatestSavedSceneVersionUseCase } from '@application/scene-export/services/ReadLatestSavedSceneVersionUseCase'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { LocalSavedSceneVersionQueryGateway } from '@infrastructure/scene-export/LocalSavedSceneVersionQueryGateway'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { versionDocumentPath } from '@infrastructure/project-versioning/versionStore'
import { previewCallerOperationId } from '@infrastructure/scene-preview/previewSaveIdentity'
import {
  PREVIEW_SAVE_DIRECTORY,
  readPreviewSaveRecord,
  writePreviewSaveRecord,
  type PreviewSaveRecord
} from '@infrastructure/scene-preview/previewSaveRecord'
import { parseLatestSavedSceneVersionResult } from '@interfaces/scene-export/contracts/SceneExportResponseSchema'

const projectId = 'project-1'
const sceneId = 'scene-1'
const entryRelativePath = 'game/scene/start.txt'
const script = '小明:当前正式的一句;\r\n'
const digest = (seed: string): string => seed.repeat(64).slice(0, 64)

let userDirectory: string
let projectRoot: string

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'latest-saved-scene-version-'))
  userDirectory = join(root, 'user')
  projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await writeFile(join(projectRoot, entryRelativePath), script, 'utf8')
  await writeProjectRegistrations(userDirectory, [
    { id: projectId, directory: projectRoot, operationId: 'op-register' }
  ])
})

afterEach(async () => {
  await rm(userDirectory, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

function recordOf(
  requestId: string,
  operationId: string,
  options: {
    sceneId?: string
    contentDigest?: string
    parserVersion?: string
    engineVersion?: string
    refusal?: PreviewSaveRecord['refusal']
    revisionDigest?: string
    relativePath?: string
  } = {}
): PreviewSaveRecord {
  const scene = options.sceneId ?? sceneId
  const contentDigest = options.contentDigest ?? digest('c')
  return {
    formatVersion: 1,
    projectId,
    sceneId: scene,
    requestId,
    callerOperationId: previewCallerOperationId(projectId, scene, requestId),
    operationId,
    baseDigest: 'base-1',
    parserVersion: options.parserVersion ?? '4.6.5',
    engineVersion: options.engineVersion ?? '4.6.5',
    editsSnapshot: '{"entries":[]}',
    committedEdits: [],
    relativePath: options.relativePath ?? entryRelativePath,
    revisionDigest:
      options.revisionDigest ?? createHash('sha256').update(script).digest('hex'),
    ...(contentDigest === '' ? {} : { contentDigest }),
    ...(options.refusal === undefined ? {} : { refusal: options.refusal })
  }
}

async function writeSavedRecord(record: PreviewSaveRecord, savedAt: Date): Promise<void> {
  await writePreviewSaveRecord(projectRoot, record)
  const path = await versionDocumentPath(
    projectRoot,
    PREVIEW_SAVE_DIRECTORY,
    `${record.callerOperationId}.json`
  )
  await utimes(path, savedAt, savedAt)
}

function sceneSource(
  options: {
    contentDigest?: string
    parserVersion?: string
    engineVersion?: string
    text?: string
    relativePath?: string
  } = {}
): ScenePreviewSourceFact {
  const text = options.text ?? script
  const bytes = new TextEncoder().encode(text)
  return {
    location: {
      projectId,
      sceneId,
      projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    snapshot: {
      projectRoot,
      entryFile: {
        relativePath: options.relativePath ?? entryRelativePath,
        kind: 'entry',
        bytes,
        text,
        size: bytes.length,
        modifiedAtMs: 0,
        digest: createHash('sha256').update(bytes).digest('hex')
      },
      files: [
        {
          relativePath: options.relativePath ?? entryRelativePath,
          kind: 'entry',
          bytes,
          text,
          size: bytes.length,
          modifiedAtMs: 0,
          digest: createHash('sha256').update(bytes).digest('hex')
        }
      ],
      missingMetadataFiles: [],
      digest: options.contentDigest ?? digest('c')
    },
    parsed: {} as never,
    references: [],
    contentBasis: {
      digest: options.contentDigest ?? digest('c'),
      parserVersion: options.parserVersion ?? '4.6.5',
      engineVersion: options.engineVersion ?? '4.6.5'
    },
    lockState: 'editable',
    sceneName: 'start',
    dialogues: [],
    issues: []
  }
}

function versioningWith(
  settlements: Readonly<Record<string, VersionSettlementVO>>
): ProjectVersioningApplicationService {
  return {
    readOperationSettlement: vi.fn(
      async (request: { operationId: string }): Promise<VersionSettlementVO> => {
        return (
          settlements[request.operationId] ?? {
            operationId: request.operationId,
            state: '待核对'
          }
        )
      }
    ),
    findCallerOperation: vi.fn(
      async (request: { sourceModule: string; callerOperationId: string }) => {
        const record = await readPreviewSaveRecord(projectRoot, request.callerOperationId).catch(
          () => null
        )
        if (!record) return null
        return {
          projectId: record.projectId,
          sourceModule: request.sourceModule,
          callerOperationId: request.callerOperationId,
          operationId: record.operationId,
          state: 'committed' as const
        }
      }
    )
  } as unknown as ProjectVersioningApplicationService
}

function subject(
  settlements: Readonly<Record<string, VersionSettlementVO>> = {},
  source: ScenePreviewSourceFact = sceneSource()
): {
  useCase: ReadLatestSavedSceneVersionUseCase
  versioning: ProjectVersioningApplicationService
} {
  const versioning = versioningWith(settlements)
  const sources: ScenePreviewSourceGateway = {
    readScenePreviewSource: vi.fn(async () => source)
  }
  return {
    versioning,
    useCase: new ReadLatestSavedSceneVersionUseCase(
      new LocalSavedSceneVersionQueryGateway(userDirectory, versioning, sources)
    )
  }
}

function committed(operationId: string): VersionSettlementVO {
  return { operationId, state: '已提交', revisionRef: 'a'.repeat(40) }
}

describe('最新可导出正式保存版本查询', () => {
  it('按保存记录时间返回该场景最新的已结算版本', async () => {
    const older = recordOf('request-older', 'operation-older')
    const newer = recordOf('request-newer', 'operation-newer')
    const otherScene = recordOf('request-other', 'operation-other', { sceneId: 'scene-2' })
    await writeSavedRecord(older, new Date(Date.now() - 60_000))
    await writeSavedRecord(newer, new Date(Date.now() - 10_000))
    await writeSavedRecord(otherScene, new Date())

    const { useCase } = subject({
      'operation-older': committed('operation-older'),
      'operation-newer': committed('operation-newer'),
      'operation-other': committed('operation-other')
    })

    await expect(useCase.readLatestSavedSceneVersion({ projectId, sceneId })).resolves.toEqual({
      versionReference: { kind: 'preview-save', requestId: 'request-newer' },
      revisionDigest: newer.revisionDigest,
      contentBasis: sceneSource().contentBasis
    })
  })

  it('只有待核对记录时返回 null', async () => {
    await writeSavedRecord(recordOf('request-pending', 'operation-pending'), new Date())
    const { useCase } = subject({
      'operation-pending': { operationId: 'operation-pending', state: '待核对' }
    })

    await expect(useCase.readLatestSavedSceneVersion({ projectId, sceneId })).resolves.toBeNull()
  })

  it('没有保存记录时返回 null', async () => {
    const { useCase, versioning } = subject()

    await expect(useCase.readLatestSavedSceneVersion({ projectId, sceneId })).resolves.toBeNull()
    expect(versioning.readOperationSettlement).not.toHaveBeenCalled()
  })

  it('记录损坏时跳过且不影响有效记录', async () => {
    const valid = recordOf('request-valid', 'operation-valid')
    await writeSavedRecord(valid, new Date())
    const corruptPath = await versionDocumentPath(
      projectRoot,
      PREVIEW_SAVE_DIRECTORY,
      'corrupt-record.json'
    )
    await mkdir(dirname(corruptPath), { recursive: true })
    await writeFile(corruptPath, '{不是合法 JSON', 'utf8')

    const { useCase } = subject({ 'operation-valid': committed('operation-valid') })

    await expect(useCase.readLatestSavedSceneVersion({ projectId, sceneId })).resolves.toEqual({
      versionReference: { kind: 'preview-save', requestId: 'request-valid' },
      revisionDigest: valid.revisionDigest,
      contentBasis: sceneSource().contentBasis
    })
  })

  it('拒绝、无摘要、过期或版本不再审计的记录不产生候选', async () => {
    const refused = recordOf('request-refused', 'operation-refused', { refusal: 'contentLocked' })
    const missing = recordOf('request-missing', 'operation-missing', { contentDigest: '' })
    const stale = recordOf('request-stale', 'operation-stale', {
      revisionDigest: digest('d')
    })
    const oldParser = recordOf('request-old-parser', 'operation-old-parser', {
      parserVersion: 'parser-r16-pin'
    })
    await writeSavedRecord(refused, new Date(Date.now() - 40_000))
    await writeSavedRecord(missing, new Date(Date.now() - 30_000))
    await writeSavedRecord(stale, new Date(Date.now() - 20_000))
    await writeSavedRecord(oldParser, new Date(Date.now() - 10_000))

    const { useCase } = subject({
      'operation-refused': committed('operation-refused'),
      'operation-missing': committed('operation-missing'),
      'operation-stale': committed('operation-stale'),
      'operation-old-parser': committed('operation-old-parser')
    })

    await expect(useCase.readLatestSavedSceneVersion({ projectId, sceneId })).resolves.toBeNull()
  })

  it('当前正式内容变化后，旧记录不再返回', async () => {
    const record = recordOf('request-saved', 'operation-saved')
    await writeSavedRecord(record, new Date())
    const changed = sceneSource({ text: '小明:另一句;\r\n' })

    const { useCase } = subject({ 'operation-saved': committed('operation-saved') }, changed)

    await expect(useCase.readLatestSavedSceneVersion({ projectId, sceneId })).resolves.toBeNull()
  })

  it('caller link 的 operation 与保存记录不一致时不返回候选', async () => {
    const record = recordOf('request-link-mismatch', 'operation-link-mismatch')
    await writeSavedRecord(record, new Date())
    const versioning = {
      readOperationSettlement: vi.fn(async () => committed(record.operationId)),
      findCallerOperation: vi.fn(async (request: { sourceModule: string; callerOperationId: string }) => ({
        projectId: record.projectId,
        sourceModule: request.sourceModule,
        callerOperationId: request.callerOperationId,
        operationId: 'another-operation',
        state: 'committed' as const
      }))
    } as unknown as ProjectVersioningApplicationService
    const sources: ScenePreviewSourceGateway = {
      readScenePreviewSource: vi.fn(async () => sceneSource())
    }
    const gateway = new LocalSavedSceneVersionQueryGateway(
      userDirectory,
      versioning,
      sources
    )
    await expect(
      gateway.listExportableSavedSceneVersions({ projectId, sceneId })
    ).resolves.toEqual([])
    expect(versioning.readOperationSettlement).not.toHaveBeenCalled()
  })

  it('wire 只暴露版本引用、摘要与内容依据', async () => {
    const record = recordOf('request-wire', 'operation-wire')
    await writeSavedRecord(record, new Date())
    const { useCase } = subject({ 'operation-wire': committed('operation-wire') })
    const latest = await useCase.readLatestSavedSceneVersion({ projectId, sceneId })
    expect(latest).not.toBeNull()

    const wire = parseLatestSavedSceneVersionResult(
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
        versionReference: { kind: 'preview-save', requestId: 'request-wire' },
        revisionDigest: record.revisionDigest,
        contentBasis: sceneSource().contentBasis
      }
    })
    expect(JSON.stringify(wire)).not.toMatch(/projectRoot|editsSnapshot|callerOperationId|operationId/)
  })
})
