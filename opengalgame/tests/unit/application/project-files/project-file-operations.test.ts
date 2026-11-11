import { describe, expect, it } from 'vitest'

import type { DesktopFileOpenGateway } from '@application/project-files/ports/DesktopFileOpenGateway'
import type {
  InspectedImportFile,
  LocatedProjectFile,
  PreparedProjectFileChange,
  ProjectFileOperationGateway
} from '@application/project-files/ports/ProjectFileOperationGateway'
import type { ProjectWorkVersionGateway } from '@application/project-files/ports/ProjectWorkVersionGateway'
import { ProjectFilesApplicationServiceImpl } from '@application/project-files/services/impl/ProjectFilesApplicationServiceImpl'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import type { ProjectStorageGateway } from '@application/projects/ports/ProjectStorageGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

function createOperations() {
  const published: string[] = []
  const opened: string[] = []
  const occupied = ['taken.png']
  const textUpdates: { sourceId: string; body: string; expectedVersion: string }[] = []
  let currentBody = '初始正文'
  const files = new Map<string, LocatedProjectFile>([
    [
      'src-1',
      {
        sourceId: 'src-1',
        fileName: 'notes.md',
        contentKind: 'text',
        textKind: 'document',
        readable: true,
        absolutePath: 'D:/works/project-1/notes.md'
      }
    ]
  ])
  const inspections = new Map<string, InspectedImportFile>()
  const filePort: ProjectFileOperationGateway = {
    inspectImportFile: async (_project, localFilePath) =>
      inspections.get(localFilePath) ?? {
        ok: false,
        fileName: '未知文件',
        message: '文件格式不受支持'
      },
    listOccupiedFileNames: async () => occupied,
    prepareImport: async (_project, sourceId, fileName) => {
      const change: PreparedProjectFileChange = {
        relativePath: `.opengalgame/inputs/sources/${sourceId}.json`,
        action: 'add'
      }
      files.set(sourceId, {
        sourceId,
        fileName,
        contentKind: 'image',
        readable: true,
        absolutePath: `D:/works/project-1/assets/${fileName}`
      })
      return [change]
    },
    locateProjectFile: async (_project, sourceId) => {
      const located = files.get(sourceId)
      if (!located) {
        throw new AppException({
          code: ProjectFileErrorCodes.sourceRecordMissing,
          msg: '来源记录不存在'
        })
      }
      return located
    },
    readProjectMedia: async () => {
      throw new Error('不应读取媒体')
    },
    prepareRename: async (_project, sourceId, newFileName) => {
      const located = files.get(sourceId)
      if (!located) {
        throw new AppException({
          code: ProjectFileErrorCodes.sourceRecordMissing,
          msg: '来源记录不存在'
        })
      }
      return [
        { relativePath: `assets/${located.fileName}`, action: 'delete' },
        { relativePath: `assets/${newFileName}`, action: 'add' }
      ]
    },
    prepareCatalogWrite: async () => ({ changes: [], watchedPaths: [] }),
    prepareTextCreate: async () => [],
    prepareTextUpdate: async (_project, spec) => {
      if (spec.expectedVersion !== 'source-v1') {
        throw new AppException({
          code: ProjectFileErrorCodes.textBodyChanged,
          msg: '正文已变化，请重新核对'
        })
      }
      textUpdates.push({ ...spec })
      currentBody = spec.body
      return [
        {
          relativePath: `.opengalgame/inputs/documents/${spec.sourceId}.md`,
          action: 'modify',
          bytes: Buffer.from(spec.body, 'utf8')
        }
      ]
    },
    prepareFileCopy: async () => ({ changes: [], watchedPaths: [] }),
    prepareSubtreeCopy: async () => ({ changes: [], watchedPaths: [] }),
    prepareOwnedDeletes: async () => ({ changes: [], watchedPaths: [] }),
    prepareDelete: async (_project, sourceId) => {
      if (!files.has(sourceId)) {
        throw new AppException({
          code: ProjectFileErrorCodes.sourceRecordMissing,
          msg: '来源记录不存在'
        })
      }
      return [{ relativePath: `.opengalgame/inputs/sources/${sourceId}.json`, action: 'delete' }]
    }
  }
  const versions: ProjectWorkVersionGateway = {
    readOperation: async () => 'unsettled',
    publish: async (request) => {
      if (request.operationId === 'unclear') {
        throw new AppException({
          code: ProjectFileErrorCodes.commitUnclear,
          msg: '提交结果不明确'
        })
      }
      published.push(request.operationId)
      occupied.push(...request.changes.flatMap((change) => change.relativePath))
    }
  }
  const desktopOpen: DesktopFileOpenGateway = {
    open: async (absolutePath) => {
      opened.push(absolutePath)
    }
  }
  let operationCount = 0
  const listQuery: ProjectListQueryGateway = {
    listRegistrations: async () => [],
    countRegistrations: async () => 0,
    findRegistration: async () => ({ id: 'project-1', directory: 'D:/works/project-1' })
  }
  const storage = {
    inspect: async () => ({
      kind: 'existing' as const,
      project: { id: 'project-1', name: '作品', synopsis: '' }
    })
  } as unknown as ProjectStorageGateway
  const service = new ProjectFilesApplicationServiceImpl({
    listQuery,
    domain: new ProjectDomainServiceImpl(),
    storage,
    sources: {
      scanProjectInputSources: async () => [],
      inspectProjectInputSources: async () => ({
        projectId: 'project-1',
        inputSourceFormatSupported: true,
        sources: [],
        catalogDamaged: false
      }),
      readProjectInputSources: async (_project, sourceIds) => ({
        projectId: 'project-1',
        readVersion: 'read-v1',
        sources: sourceIds.map((sourceId) => ({
          sourceId,
          version: 'source-v2',
          contentKind: 'text' as const,
          textKind: 'document' as const,
          title: 'notes.md',
          body: currentBody,
          topics: [],
          importFormat: 'markdown' as const
        }))
      }),
      readProjectInputCatalog: async () => ({
        projectId: 'project-1',
        catalogVersion: 'catalog-v1',
        folders: [],
        sources: [
          {
            sourceId: 'taken',
            name: 'taken.png',
            readable: true,
            parentFolderId: null,
            contentKind: 'image'
          }
        ]
      }),
      readFolderDeletionPlan: async () => {
        throw new Error('不应读取删除计划')
      }
    },
    arrangements: {
      inspectSceneCanvasArrangements: async () => ({
        projectId: 'project-1',
        canvasArrangementFormatSupported: true,
        arrangements: []
      })
    },
    files: filePort,
    versions,
    desktopOpen,
    createSourceId: () => `source-${files.size + 1}`,
    createOperationId: () => {
      operationCount += 1
      return operationCount === 2 ? 'unclear' : `op-${operationCount}`
    }
  })
  return { service, published, opened, inspections, occupied, textUpdates }
}

describe('工程文件操作编排', () => {
  it('空导入列表和未登记工程直接失败', async () => {
    const { service } = createOperations()
    await expect(
      service.importProjectFiles({
        projectId: 'project-1',
        parentFolderId: null,
        expectedCatalogVersion: 'catalog-v1',
        localFilePaths: []
      })
    ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })
    const unregistered = new ProjectFilesApplicationServiceImpl({
      listQuery: {
        listRegistrations: async () => [],
        countRegistrations: async () => 0,
        findRegistration: async () => null
      },
      domain: new ProjectDomainServiceImpl(),
      storage: { inspect: async () => ({ kind: 'missing' }) } as unknown as ProjectStorageGateway,
      sources: {
        scanProjectInputSources: async () => [],
        inspectProjectInputSources: async () => {
          throw new Error('不应检查')
        },
        readProjectInputSources: async () => {
          throw new Error('不应读取')
        }
      },
      arrangements: {
        inspectSceneCanvasArrangements: async () => {
          throw new Error('不应检查编排')
        }
      }
    })
    await expect(
      unregistered.importProjectFiles({
        projectId: 'missing',
        parentFolderId: null,
        expectedCatalogVersion: 'catalog-v1',
        localFilePaths: ['C:/a.png']
      })
    ).rejects.toBeInstanceOf(AppException)
  })

  it('导入成功后继续处理普通失败，提交不明时停止后续文件', async () => {
    const { service, inspections, published } = createOperations()
    inspections.set('C:/ok.png', { ok: true, fileName: 'ok.png', fileType: 'image' })
    inspections.set('C:/bad.txt', { ok: false, fileName: 'bad.txt', message: '文件格式不受支持' })
    inspections.set('C:/later.png', { ok: true, fileName: 'later.png', fileType: 'image' })
    await expect(
      service.importProjectFiles({
        projectId: 'project-1',
        parentFolderId: null,
        expectedCatalogVersion: 'catalog-v1',
        localFilePaths: ['C:/ok.png', 'C:/bad.txt', 'C:/later.png']
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.commitUnclear })
    expect(published).toEqual(['op-1'])
  })

  it('同名导入追加序号，名称未变化的重命名不提交', async () => {
    const { service, inspections, published } = createOperations()
    inspections.set('C:/taken.png', { ok: true, fileName: 'taken.png', fileType: 'image' })
    const imported = await service.importProjectFiles({
      projectId: 'project-1',
      parentFolderId: null,
      expectedCatalogVersion: 'catalog-v1',
      localFilePaths: ['C:/taken.png']
    })
    expect(imported.importedFiles[0]?.name).toBe('taken (1).png')
    expect(published).toEqual(['op-1'])
    const renamed = await service.renameProjectFile({
      projectId: 'project-1',
      sourceId: 'src-1',
      newFileName: 'Notes.md',
      expectedCatalogVersion: 'catalog-v1'
    })
    expect(renamed.name).toBe('notes.md')
    expect(published).toEqual(['op-1'])
  })

  it('保存正文只提交正文文件，返回保存后的来源', async () => {
    const { service, published, textUpdates } = createOperations()
    const updated = await service.updateProjectTextFileBody({
      projectId: 'project-1',
      sourceId: 'src-1',
      expectedSourceVersion: 'source-v1',
      content: { textKind: 'document', body: '新正文' }
    })
    expect(textUpdates).toEqual([
      { sourceId: 'src-1', expectedVersion: 'source-v1', body: '新正文' }
    ])
    expect(published).toEqual(['op-1'])
    expect(updated).toEqual({
      sourceId: 'src-1',
      version: 'source-v2',
      contentKind: 'text',
      textKind: 'document',
      title: 'notes.md',
      body: '新正文',
      topics: [],
      importInfo: { format: 'markdown' }
    })
  })

  it('允许保存空正文', async () => {
    const { service, textUpdates } = createOperations()
    const updated = await service.updateProjectTextFileBody({
      projectId: 'project-1',
      sourceId: 'src-1',
      expectedSourceVersion: 'source-v1',
      content: { textKind: 'document', body: '' }
    })
    expect(textUpdates).toEqual([{ sourceId: 'src-1', expectedVersion: 'source-v1', body: '' }])
    expect(updated.body).toBe('')
  })

  it('空白来源标识、空白版本和过期版本都不提交', async () => {
    const { service, published, textUpdates } = createOperations()
    await expect(
      service.updateProjectTextFileBody({
        projectId: 'project-1',
        sourceId: ' ',
        expectedSourceVersion: 'source-v1',
        content: { textKind: 'document', body: '新正文' }
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.blankSourceId })
    await expect(
      service.updateProjectTextFileBody({
        projectId: 'project-1',
        sourceId: 'src-1',
        expectedSourceVersion: ' ',
        content: { textKind: 'document', body: '新正文' }
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.blankSourceVersion })
    await expect(
      service.updateProjectTextFileBody({
        projectId: 'project-1',
        sourceId: 'src-1',
        expectedSourceVersion: 'stale',
        content: { textKind: 'document', body: '新正文' }
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.textBodyChanged })
    expect(textUpdates).toEqual([])
    expect(published).toEqual([])
  })

  it('打开不提交，删除提交来源记录', async () => {
    const { service, published, opened } = createOperations()
    await service.openProjectFile({ projectId: 'project-1', sourceId: 'src-1' })
    expect(opened).toEqual(['D:/works/project-1/notes.md'])
    expect(published).toEqual([])
    await service.deleteProjectFile({
      projectId: 'project-1',
      sourceId: 'src-1',
      expectedCatalogVersion: 'catalog-v1'
    })
    expect(published).toEqual(['op-1'])
    await expect(
      service.deleteProjectFile({
        projectId: 'project-1',
        sourceId: 'missing',
        expectedCatalogVersion: 'catalog-v1'
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.sourceRecordMissing })
  })
})
