import { describe, expect, it } from 'vitest'

import type {
  ProjectInputSourceInspectionFact,
  VerifiedProjectReadLocation
} from '@application/project-files/models/ProjectInputSourceReadFacts'
import type { SceneCanvasArrangementInspectionFact } from '@application/project-files/models/SceneCanvasArrangementReadFacts'
import type { ProjectInputSourceReaderGateway } from '@application/project-files/ports/ProjectInputSourceReaderGateway'
import type { SceneCanvasArrangementReaderGateway } from '@application/project-files/ports/SceneCanvasArrangementReaderGateway'
import { ProjectFilesApplicationServiceImpl } from '@application/project-files/services/impl/ProjectFilesApplicationServiceImpl'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import type { ProjectStorageGateway } from '@application/projects/ports/ProjectStorageGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { SceneCanvasArrangement } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import type {
  ProjectFileAssetKind,
  ProjectInputSource,
  ProjectInputSourceSummary
} from '@domain/project-files/models/ProjectInputSource'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

const assetKinds: readonly ProjectFileAssetKind[] = ['image', 'audio', 'video']

function documentSource(
  patch: Partial<Extract<ProjectInputSource, { textKind: 'document' }>> = {}
): Extract<ProjectInputSource, { textKind: 'document' }> {
  return {
    sourceId: 'doc-1',
    version: 'source-v1',
    contentKind: 'text' as const,
    textKind: 'document' as const,
    title: '标题',
    body: '正文',
    topics: ['角色'],
    importFormat: 'markdown' as const,
    ...patch
  }
}

function arrangement(
  cards: SceneCanvasArrangement['cards'] = canvasCards(),
  canvasId = 'canvas-1'
): SceneCanvasArrangement {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId,
    viewport: { x: 0, y: 0, zoom: 1 },
    relations: [],
    cards
  }
}

function canvasCards(): SceneCanvasArrangement['cards'] {
  return [
    {
      cardId: 'card-1',
      kind: 'document',
      sourceId: 'doc-1',
      title: '设定',
      summary: '',
      layout: { x: 1, y: 2, width: 30, height: 40 }
    },
    {
      cardId: 'card-2',
      kind: 'document',
      sourceId: 'doc-1',
      title: '设定',
      summary: '',
      layout: { x: 8, y: 9, width: 10, height: 12 }
    }
  ]
}

function createService(options?: {
  registrationId?: string | null
  workspaceId?: string
  workspaceKind?: 'existing' | 'uninitialized'
}): {
  service: ProjectFilesApplicationServiceImpl
  useSources: (next: ProjectInputSourceReaderGateway) => void
  useArrangements: (next: SceneCanvasArrangementReaderGateway) => void
} {
  const registrationId =
    options && 'registrationId' in options ? options.registrationId : 'project-1'
  const workspaceId = options?.workspaceId ?? 'project-1'
  const listQuery: ProjectListQueryGateway = {
    listRegistrations: async () => [],
    countRegistrations: async () => 0,
    findRegistration: async () =>
      registrationId === null ? null : { id: registrationId, directory: 'D:/works/project-1' }
  }
  const storage = {
    inspect: async () =>
      options?.workspaceKind === 'uninitialized'
        ? { kind: 'uninitialized' as const, directoryName: 'project-1' }
        : {
            kind: 'existing' as const,
            project: { id: workspaceId, name: '作品', synopsis: '' }
          }
  } as unknown as ProjectStorageGateway
  let sources: ProjectInputSourceReaderGateway = {
    scanProjectInputSources: async () => [],
    inspectProjectInputSources: async () => ({
      projectId: 'project-1',
      inputSourceFormatSupported: true,
      sources: []
    }),
    readProjectInputSources: async () => ({
      projectId: 'project-1',
      readVersion: 'read-v1',
      sources: []
    })
  }
  let arrangements: SceneCanvasArrangementReaderGateway = {
    inspectSceneCanvasArrangements: async () => ({
      projectId: 'project-1',
      canvasArrangementFormatSupported: true,
      arrangements: []
    })
  }
  const service = new ProjectFilesApplicationServiceImpl({
    listQuery,
    domain: new ProjectDomainServiceImpl(),
    storage,
    get sources() {
      return sources
    },
    get arrangements() {
      return arrangements
    }
  })
  return {
    service,
    useSources(next: ProjectInputSourceReaderGateway) {
      sources = next
    },
    useArrangements(next: SceneCanvasArrangementReaderGateway) {
      arrangements = next
    }
  }
}

describe('ProjectFilesApplicationServiceImpl', () => {
  it('未登记、未初始化或真实身份不一致时拒绝读取', async () => {
    await expect(
      createService({ registrationId: null }).service.listProjectInputSources({
        projectId: 'project-1'
      })
    ).rejects.toMatchObject({ code: 1209 })
    await expect(
      createService({ workspaceKind: 'uninitialized' }).service.inspectProjectFiles({
        projectId: 'project-1'
      })
    ).rejects.toMatchObject({ code: 1206 })
    await expect(
      createService({ workspaceId: 'other-project' }).service.listProjectInputSources({
        projectId: 'project-1'
      })
    ).rejects.toMatchObject({ code: 1203 })
  })

  it('扫描保留不可读取来源，重复身份都不可读，整次失败不是空目录', async () => {
    const { service, useSources } = createService()
    const summaries: ProjectInputSourceSummary[] = [
      {
        sourceId: 'doc-1',
        name: '设定',
        readable: false,
        contentKind: 'text',
        textKind: 'document'
      },
      { sourceId: 'dup', name: '甲', readable: true, contentKind: 'audio' },
      { sourceId: 'dup', name: '乙', readable: true, contentKind: 'audio' },
      {
        sourceId: 'prompt-1',
        name: '语气',
        readable: true,
        contentKind: 'text',
        textKind: 'document'
      }
    ]
    useSources({
      scanProjectInputSources: async () => summaries,
      inspectProjectInputSources: async () => {
        throw new Error('不应检查')
      },
      readProjectInputSources: async () => {
        throw new Error('不应读取正文')
      },
      readProjectInputCatalog: async () => ({
        projectId: 'project-1',
        catalogVersion: 'catalog-v1',
        folders: [],
        sources: summaries.map((summary) => ({ ...summary, parentFolderId: null }))
      }),
      readFolderDeletionPlan: async () => {
        throw new Error('不应读取删除计划')
      }
    })
    await expect(service.listProjectInputSources({ projectId: 'project-1' })).resolves.toEqual({
      projectId: 'project-1',
      catalogVersion: 'catalog-v1',
      folders: [],
      sources: [
        { ...summaries[0], parentFolderId: null },
        { ...summaries[1], readable: false, parentFolderId: null },
        { ...summaries[2], readable: false, parentFolderId: null },
        { ...summaries[3], parentFolderId: null }
      ]
    })
    useSources({
      scanProjectInputSources: async () => {
        throw new AppException({ code: ProjectFileErrorCodes.readFailed, msg: '工程文件无法读取' })
      },
      readProjectInputCatalog: async () => {
        throw new AppException({ code: ProjectFileErrorCodes.readFailed, msg: '工程文件无法读取' })
      },
      inspectProjectInputSources: async () => {
        throw new Error('不应检查')
      },
      readProjectInputSources: async () => {
        throw new Error('不应读取正文')
      }
    })
    await expect(service.listProjectInputSources({ projectId: 'project-1' })).rejects.toMatchObject(
      {
        code: ProjectFileErrorCodes.readFailed
      }
    )
  })

  it('空白名称的可识别摘要标为不可读，不让整次扫描失败', async () => {
    const { service, useSources } = createService()
    useSources({
      scanProjectInputSources: async () => [
        {
          sourceId: 'doc-blank',
          name: '  ',
          readable: true,
          contentKind: 'text',
          textKind: 'document'
        },
        {
          sourceId: 'doc-ok',
          name: '设定',
          readable: true,
          contentKind: 'text',
          textKind: 'document'
        }
      ],
      inspectProjectInputSources: async () => {
        throw new Error('不应检查')
      },
      readProjectInputSources: async () => {
        throw new Error('不应读取正文')
      },
      readProjectInputCatalog: async () => ({
        projectId: 'project-1',
        catalogVersion: 'catalog-v1',
        folders: [],
        sources: [
          {
            sourceId: 'doc-blank',
            name: '  ',
            readable: true,
            parentFolderId: null,
            contentKind: 'text' as const,
            textKind: 'document' as const
          },
          {
            sourceId: 'doc-ok',
            name: '设定',
            readable: true,
            parentFolderId: null,
            contentKind: 'text' as const,
            textKind: 'document' as const
          }
        ]
      }),
      readFolderDeletionPlan: async () => {
        throw new Error('不应读取删除计划')
      }
    })
    await expect(service.listProjectInputSources({ projectId: 'project-1' })).resolves.toEqual({
      projectId: 'project-1',
      catalogVersion: 'catalog-v1',
      folders: [],
      sources: [
        {
          sourceId: 'doc-blank',
          name: '  ',
          readable: false,
          parentFolderId: null,
          contentKind: 'text',
          textKind: 'document'
        },
        {
          sourceId: 'doc-ok',
          name: '设定',
          readable: true,
          parentFolderId: null,
          contentKind: 'text',
          textKind: 'document'
        }
      ]
    })
  })

  it('批量读取保留格式和素材引用，请求不对应时不返回快照', async () => {
    const { service, useSources } = createService()
    const assets = assetKinds.map((contentKind): ProjectInputSource => ({
      sourceId: contentKind,
      version: 'asset-v',
      contentKind,
      name: contentKind,
      fileId: `file-${contentKind}`,
      description: '说明'
    }))
    const sources = [documentSource({ importFormat: 'plainText' }), ...assets]
    useSources({
      scanProjectInputSources: async () => [],
      inspectProjectInputSources: async () => {
        throw new Error('不应检查')
      },
      readProjectInputSources: async (_project: VerifiedProjectReadLocation, sourceIds) => ({
        projectId: 'project-1',
        readVersion: 'read-v1',
        sources: sources.filter((source) => sourceIds.includes(source.sourceId))
      })
    })
    const snapshot = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-1', ...assetKinds]
    })
    expect(snapshot.readVersion).toBe('read-v1')
    expect(snapshot.sources.find((source) => source.sourceId === 'doc-1')).toMatchObject({
      textKind: 'document',
      importInfo: { format: 'plainText' }
    })
    expect(
      snapshot.sources
        .filter(
          (source) =>
            source.sourceId !== 'doc-1' &&
            assetKinds.includes(source.contentKind as ProjectFileAssetKind)
        )
        .map((source) => {
          if (!('fileId' in source)) throw new Error('缺少文件引用')
          return source.fileId
        })
    ).toEqual(assetKinds.map((kind) => `file-${kind}`))
    expect(JSON.stringify(snapshot)).not.toContain('D:/')
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['doc-1', 'doc-1'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.duplicateSourceId })
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['doc-1', 'missing'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.sourceSetMismatch })
    useSources({
      scanProjectInputSources: async () => [],
      inspectProjectInputSources: async () => {
        throw new Error('不应检查')
      },
      readProjectInputSources: async () => {
        throw new AppException({
          code: ProjectFileErrorCodes.readChanged,
          msg: '工程文件在读取期间发生变化'
        })
      }
    })
    await expect(
      service.readProjectInputSources({ projectId: 'project-1', sourceIds: ['doc-1'] })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.readChanged })
    expect(snapshot.sources.map((source) => source.sourceId)).toContain('doc-1')
  })

  it('工程检查汇总多份编排的诊断，并拒绝其他工程的事实', async () => {
    const { service, useSources, useArrangements } = createService()
    const sourceFacts: ProjectInputSourceInspectionFact = {
      projectId: 'project-1',
      inputSourceFormatSupported: false,
      sources: [
        { availability: 'present', source: documentSource() },
        {
          availability: 'present',
          source: documentSource({ sourceId: 'doc-1', version: 'other' })
        },
        { availability: 'damaged', sourceId: 'broken' }
      ]
    }
    const arrangementFacts: SceneCanvasArrangementInspectionFact = {
      projectId: 'project-1',
      canvasArrangementFormatSupported: true,
      arrangements: [
        { availability: 'damaged', objectId: 'canvas-broken' },
        { availability: 'present', arrangement: arrangement() },
        {
          availability: 'present',
          arrangement: arrangement(
            [
              {
                cardId: 'card-lost',
                kind: 'document',
                sourceId: 'gone',
                title: '缺失',
                summary: '',
                layout: { x: 0, y: 0, width: 4, height: 4 }
              }
            ],
            'canvas-2'
          )
        }
      ]
    }
    useSources({
      scanProjectInputSources: async () => [],
      inspectProjectInputSources: async () => sourceFacts,
      readProjectInputSources: async () => {
        throw new Error('不应读取正文')
      }
    })
    useArrangements({
      inspectSceneCanvasArrangements: async () => arrangementFacts
    })
    await expect(service.inspectProjectFiles({ projectId: 'project-1' })).resolves.toEqual({
      projectId: 'project-1',
      inputSourceFormatSupported: false,
      canvasArrangementFormatSupported: true,
      diagnostics: [
        { objectId: 'doc-1', kind: 'duplicateIdentity' },
        { objectId: 'broken', kind: 'damaged' },
        { objectId: 'canvas-broken', kind: 'damaged' },
        { objectId: 'card-lost', kind: 'brokenReference' }
      ]
    })
    useSources({
      scanProjectInputSources: async () => [],
      inspectProjectInputSources: async () => ({ ...sourceFacts, projectId: 'other-project' }),
      readProjectInputSources: async () => {
        throw new Error('不应读取正文')
      }
    })
    await expect(service.inspectProjectFiles({ projectId: 'project-1' })).rejects.toMatchObject({
      code: ProjectFileErrorCodes.ownershipMismatch
    })
  })
})
