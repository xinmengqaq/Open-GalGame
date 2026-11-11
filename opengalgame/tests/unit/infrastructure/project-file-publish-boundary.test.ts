import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as git from 'isomorphic-git'
import * as fs from 'node:fs'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { ProjectFilesApplicationServiceImpl } from '@application/project-files/services/impl/ProjectFilesApplicationServiceImpl'
import type { ProjectFileOperationGateway } from '@application/project-files/ports/ProjectFileOperationGateway'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import type { ProjectStorageGateway } from '@application/projects/ports/ProjectStorageGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'
import { LocalProjectFileOperationGatewayImpl } from '@infrastructure/project-files/LocalProjectFileOperationGatewayImpl'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'
import { MAX_TEXT_CHARS } from '@infrastructure/project-files/projectFilePaths'
import { writeLooseBlobFromFile } from '@infrastructure/git/objects/writeLooseBlob'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('导入识别', () => {
  it('大媒体只读前缀，超限文本在读入前拒绝', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengalgame-import-prefix-'))
    directories.push(directory)
    const video = join(directory, 'clip.png')
    const header = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000020001e221bc330000000049454e44ae426082',
      'hex'
    )
    const gateway = new LocalProjectFileOperationGatewayImpl()
    const project = { projectId: 'project-1', location: { directory } }
    const warmup = join(directory, 'warmup.png')
    await writeFile(warmup, header)
    await gateway.inspectImportFile(project, warmup)
    await writeFile(video, Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024)]))
    const before = process.memoryUsage().heapUsed
    await expect(gateway.inspectImportFile(project, video)).resolves.toMatchObject({
      ok: true,
      fileType: 'image'
    })
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(1024 * 1024)

    const text = join(directory, 'too-big.txt')
    await writeFile(text, Buffer.alloc(MAX_TEXT_CHARS * 4 + 1))
    await expect(gateway.inspectImportFile(project, text)).resolves.toMatchObject({
      ok: false,
      fileName: 'too-big.txt'
    })
  })
})

describe('流式 blob', () => {
  it('写入后可以被 Git 按原字节读回', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'opengalgame-loose-blob-'))
    directories.push(gitDir)
    const filePath = join(gitDir, 'source.bin')
    await writeFile(filePath, 'hello')
    await git.init({ fs, dir: gitDir, bare: true, defaultBranch: 'revisions' })
    const oid = await writeLooseBlobFromFile(gitDir, filePath, 5)
    const blob = await git.readBlob({ fs, gitdir: gitDir, oid })
    expect(Buffer.from(blob.blob).toString()).toBe('hello')
  })
})

describe('提交结果不明', () => {
  it('已提交视为成功，结果不明或补偿失败则中断后续文件', async () => {
    const committed = await importTwo('committed')
    expect(committed.imported.map((file) => file.name)).toEqual(['a.png', 'b.png'])
    expect(committed.commits).toBe(2)

    const unknown = { commits: 0 }
    await expect(importTwo('unknown', unknown)).rejects.toMatchObject({
      code: ProjectFileErrorCodes.commitUnclear
    })
    expect(unknown.commits).toBe(1)

    const compensate = { commits: 0 }
    await expect(importTwo('compensate', compensate)).rejects.toMatchObject({
      code: ProjectFileErrorCodes.commitUnclear
    })
    expect(compensate.commits).toBe(1)
  })
})

async function importTwo(
  mode: 'committed' | 'unknown' | 'compensate',
  observed: { commits: number } = { commits: 0 }
): Promise<{
  imported: { name: string }[]
  commits: number
}> {
  let published = 0
  const callerOperations = new Map<string, string>()
  const versioning = {
    prepareOperation: async () => ({
      operationId: `version-${published + 1}`,
      baselineRef: 'baseline-1',
      revisionRef: 'rev-1'
    }),
    bindCallerOperation: async (request: { callerOperationId: string; operationId: string }) => {
      const previous = callerOperations.get(request.callerOperationId)
      if (previous && previous !== request.operationId) throw new Error('调用方身份已绑定')
      callerOperations.set(request.callerOperationId, request.operationId)
    },
    readCallerOperation: async (request: { callerOperationId: string }) => {
      const operationId = callerOperations.get(request.callerOperationId)
      return operationId
        ? {
            projectId: 'project-1',
            sourceModule: 'project-files',
            callerOperationId: request.callerOperationId,
            operationId
          }
        : null
    },
    commitOperation: async (
      _request: unknown,
      requirePreconditions: () => void | Promise<void>
    ) => {
      await requirePreconditions()
      published += 1
      observed.commits = published
      if (published === 1 && mode === 'compensate') {
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '作品提交失败，且恢复正式文件也失败',
          cause: new AggregateError([new Error('write'), new Error('restore')], '提交与补偿失败')
        })
      }
      if (published === 1 && mode === 'unknown') {
        throw new AppException({
          code: ProjectVersioningErrorCodes.insufficientEvidence,
          msg: '提交结果不明，不能重试'
        })
      }
      return {
        operationId: `version-${published}`,
        state: '已提交' as const,
        revisionRef: 'kept'
      }
    },
    readOperationSettlement: async () => ({
      operationId: 'unread',
      state: '待核对' as const
    })
  } as ProjectVersioningApplicationService
  const files: ProjectFileOperationGateway = {
    inspectImportFile: async (_project, localFilePath) => ({
      ok: true,
      fileName: localFilePath,
      fileType: 'image'
    }),
    listOccupiedFileNames: async () => [],
    prepareImport: async (_project, sourceId, fileName) => [
      {
        relativePath: `.opengalgame/inputs/sources/${sourceId}.json`,
        action: 'add',
        bytes: Buffer.from('{}')
      },
      { relativePath: `assets/${fileName}`, action: 'add', bytes: Buffer.from('img') }
    ],
    locateProjectFile: async () => {
      throw new Error('不应定位')
    },
    readProjectMedia: async () => {
      throw new Error('不应读取媒体')
    },
    prepareRename: async () => {
      throw new Error('不应重命名')
    },
    prepareDelete: async () => {
      throw new Error('不应删除')
    },
    prepareCatalogWrite: async () => ({ changes: [], watchedPaths: [] }),
    prepareTextCreate: async () => [],
    prepareFileCopy: async () => ({ changes: [], watchedPaths: [] }),
    prepareSubtreeCopy: async () => ({ changes: [], watchedPaths: [] }),
    prepareOwnedDeletes: async () => ({ changes: [], watchedPaths: [] })
  }
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
  let sourceCount = 0
  const service = new ProjectFilesApplicationServiceImpl({
    listQuery,
    domain: new ProjectDomainServiceImpl(),
    storage,
    sources: {
      scanProjectInputSources: async () => [],
      inspectProjectInputSources: async () => {
        throw new Error('不应检查')
      },
      readProjectInputSources: async () => {
        throw new Error('不应读取')
      },
      readProjectInputCatalog: async () => ({
        projectId: 'project-1',
        catalogVersion: 'catalog-v1',
        folders: [],
        sources: []
      }),
      readFolderDeletionPlan: async () => {
        throw new Error('不应读取删除计划')
      }
    },
    arrangements: {
      inspectSceneCanvasArrangements: async () => {
        throw new Error('不应检查编排')
      },
      readSceneCanvasArrangement: async () => null
    },
    files,
    versions: new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v1'),
    desktopOpen: { open: async () => undefined },
    createSourceId: () => `source-${++sourceCount}`,
    createOperationId: () => `operation-${sourceCount}`
  })
  const imported = await service.importProjectFiles({
    projectId: 'project-1',
    parentFolderId: null,
    expectedCatalogVersion: 'catalog-v1',
    localFilePaths: ['a.png', 'b.png']
  })
  return {
    imported: imported.importedFiles.map((file) => ({ name: file.name })),
    commits: observed.commits
  }
}
