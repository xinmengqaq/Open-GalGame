import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { ReadLatestPreviewSaveUseCase } from '@application/scene-export/services/ReadLatestPreviewSaveUseCase'
import { LocalPreviewSaveVersionQueryGateway } from '@infrastructure/scene-export/LocalPreviewSaveVersionQueryGateway'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { versionDocumentPath } from '@infrastructure/project-versioning/versionStore'
import { previewCallerOperationId } from '@infrastructure/scene-preview/previewSaveIdentity'
import {
  PREVIEW_SAVE_DIRECTORY,
  writePreviewSaveRecord,
  type PreviewSaveRecord
} from '@infrastructure/scene-preview/previewSaveRecord'

const projectId = 'project-1'
const sceneId = 'scene-1'
const digest = (seed: string): string => seed.repeat(64).slice(0, 64)

let userDirectory: string
let projectRoot: string

beforeEach(async () => {
  userDirectory = await mkdtemp(join(tmpdir(), 'scene-export-query-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'scene-export-project-'))
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  await writeProjectRegistrations(userDirectory, [
    { id: projectId, directory: projectRoot, operationId: 'register-1' }
  ])
})

afterEach(async () => {
  await rm(userDirectory, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

function recordOf(
  requestId: string,
  operationId: string,
  options: { sceneId?: string; contentDigest?: string } = {}
): PreviewSaveRecord {
  const scene = options.sceneId ?? sceneId
  const contentDigest = options.contentDigest ?? digest('b')
  return {
    formatVersion: 1,
    projectId,
    sceneId: scene,
    requestId,
    callerOperationId: previewCallerOperationId(projectId, scene, requestId),
    operationId,
    baseDigest: 'base-1',
    parserVersion: '4.6.5',
    engineVersion: '4.6.5',
    editsSnapshot: '{"entries":[]}',
    committedEdits: [],
    relativePath: 'game/scene/start.txt',
    revisionDigest: digest('a'),
    ...(contentDigest === '' ? {} : { contentDigest })
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
    )
  } as unknown as ProjectVersioningApplicationService
}

function subject(settlements: Readonly<Record<string, VersionSettlementVO>> = {}): {
  useCase: ReadLatestPreviewSaveUseCase
  versioning: ProjectVersioningApplicationService
} {
  const versioning = versioningWith(settlements)
  return {
    versioning,
    useCase: new ReadLatestPreviewSaveUseCase(
      new LocalPreviewSaveVersionQueryGateway(userDirectory, versioning)
    )
  }
}

function committed(operationId: string): VersionSettlementVO {
  return { operationId, state: '已提交', revisionRef: 'revision-1' }
}

describe('最近一次已结算的预览保存版本查询', () => {
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

    await expect(useCase.readLatestPreviewSave({ projectId, sceneId })).resolves.toEqual({
      requestId: 'request-newer',
      revisionDigest: newer.revisionDigest,
      contentBasis: {
        digest: newer.contentDigest,
        parserVersion: '4.6.5',
        engineVersion: '4.6.5'
      }
    })
  })

  it('只有待核对记录时返回 null', async () => {
    await writeSavedRecord(recordOf('request-pending', 'operation-pending'), new Date())
    const { useCase } = subject({ 'operation-pending': { operationId: 'operation-pending', state: '待核对' } })

    await expect(useCase.readLatestPreviewSave({ projectId, sceneId })).resolves.toBeNull()
  })

  it('没有保存记录时返回 null', async () => {
    const { useCase, versioning } = subject()

    await expect(useCase.readLatestPreviewSave({ projectId, sceneId })).resolves.toBeNull()
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

    await expect(useCase.readLatestPreviewSave({ projectId, sceneId })).resolves.toEqual({
      requestId: 'request-valid',
      revisionDigest: valid.revisionDigest,
      contentBasis: {
        digest: valid.contentDigest,
        parserVersion: '4.6.5',
        engineVersion: '4.6.5'
      }
    })
  })
})
