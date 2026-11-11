import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as git from 'isomorphic-git'

import type { DesktopFileOpenGateway } from '@application/project-files/ports/DesktopFileOpenGateway'
import type { ProjectFileOperationGateway } from '@application/project-files/ports/ProjectFileOperationGateway'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { ProjectFilesApplicationServiceImpl } from '@application/project-files/services/impl/ProjectFilesApplicationServiceImpl'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalProjectFileOperationGatewayImpl } from '@infrastructure/project-files/LocalProjectFileOperationGatewayImpl'
import { LocalProjectInputSourceReaderGatewayImpl } from '@infrastructure/project-files/LocalProjectInputSourceReaderGatewayImpl'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'
import { LocalSceneCanvasArrangementInspectionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementInspectionGatewayImpl'
import { LocalProjectStorageGatewayImpl } from '@infrastructure/projects/LocalProjectStorageGatewayImpl'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function seedRepository(root: string): Promise<void> {
  await mkdir(join(root, '.opengalgame'), { recursive: true })
  await writeFile(
    join(root, '.opengalgame/manifest.json'),
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-seed' }, null, 2)}\n`
  )
  await writeFile(
    join(root, '.opengalgame/project.json'),
    `${JSON.stringify({ id: 'project-1', name: '作品', synopsis: '' }, null, 2)}\n`
  )
  const author = {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: 1,
    timezoneOffset: 0
  }
  await git.init({ fs, dir: root, defaultBranch: 'main' })
  await git.add({ fs, dir: root, filepath: '.opengalgame/manifest.json' })
  await git.add({ fs, dir: root, filepath: '.opengalgame/project.json' })
  await git.commit({ fs, dir: root, message: '建立工程', author, committer: author })
}

async function createService(
  root: string,
  opened: string[],
  files: ProjectFileOperationGateway = new LocalProjectFileOperationGatewayImpl(),
  idPrefix = ''
): Promise<ProjectFilesApplicationServiceImpl> {
  const userDirectory = await temporaryDirectory('opengalgame-file-user-')
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: root, operationId: 'op-register' }
  ])
  const listQuery: ProjectListQueryGateway = {
    listRegistrations: async () => [],
    countRegistrations: async () => 0,
    findRegistration: async () => ({ id: 'project-1', directory: root })
  }
  const desktopOpen: DesktopFileOpenGateway = {
    open: async (absolutePath) => {
      opened.push(absolutePath)
    }
  }
  const sources = new LocalProjectInputSourceReaderGatewayImpl()
  let sourceCount = 0
  let operationCount = 0
  return new ProjectFilesApplicationServiceImpl({
    listQuery,
    domain: new ProjectDomainServiceImpl(),
    storage: new LocalProjectStorageGatewayImpl(),
    sources,
    arrangements: new LocalSceneCanvasArrangementInspectionGatewayImpl(),
    files,
    versions: new LocalProjectWorkVersionGatewayImpl(
      new ProjectVersioningApplicationServiceImpl({
        ...createProjectVersioningGateways(userDirectory),
        nextId: randomUUID
      }),
      (project) =>
        sources.readProjectInputCatalog(project).then((catalog) => catalog.catalogVersion)
    ),
    desktopOpen,
    createSourceId: () => `${idPrefix}source-${++sourceCount}`,
    createOperationId: () => `${idPrefix}operation-${++operationCount}`
  })
}

describe('工程文件写入适配', () => {
  it('导入、重命名和删除真实文件，并保留已提交结果', async () => {
    const root = await temporaryDirectory('opengalgame-file-op-')
    const outside = await temporaryDirectory('opengalgame-file-src-')
    await seedRepository(root)
    await writeFile(join(outside, '笔记.md'), '# 正文\n', 'utf8')
    const opened: string[] = []
    const service = await createService(root, opened)

    const imported = await importFiles(service, [join(outside, '笔记.md')])
    expect(imported.failedFiles).toEqual([])
    expect(imported.importedFiles[0]).toMatchObject({
      name: '笔记.md',
      contentKind: 'text',
      textKind: 'document',
      readable: true
    })
    expect(await readFile(join(outside, '笔记.md'), 'utf8')).toBe('# 正文\n')

    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.sources.map((item) => item.name)).toContain('笔记.md')
    const sourceId = imported.importedFiles[0]?.sourceId ?? ''
    await service.openProjectFile({ projectId: 'project-1', sourceId })
    expect(opened).toHaveLength(1)

    const renamed = await service.renameProjectFile({
      projectId: 'project-1',
      sourceId,
      newFileName: '章节.md',
      expectedCatalogVersion: listed.catalogVersion
    })
    expect(renamed.name).toBe('章节.md')
    const beforeDelete = await service.listProjectInputSources({ projectId: 'project-1' })
    await service.deleteProjectFile({
      projectId: 'project-1',
      sourceId,
      expectedCatalogVersion: beforeDelete.catalogVersion
    })
    const afterDelete = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(afterDelete.sources.find((item) => item.sourceId === sourceId)).toBeUndefined()
  })

  it('已有或未提交的同名素材不会被导入或重命名覆盖', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000020001e221bc330000000049454e44ae426082',
      'hex'
    )
    const root = await temporaryDirectory('opengalgame-file-cover-')
    const outside = await temporaryDirectory('opengalgame-file-cover-src-')
    await seedRepository(root)
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'assets/cover.png'), png)
    await git.add({ fs, dir: root, filepath: 'assets/cover.png' })
    await git.commit({
      fs,
      dir: root,
      message: '已有素材',
      author: {
        name: 'opengalgame',
        email: 'opengalgame@localhost',
        timestamp: 2,
        timezoneOffset: 0
      }
    })
    const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' })
    await writeFile(join(outside, 'cover.png'), Buffer.concat([png, Buffer.from('new')]))
    const service = await createService(root, [])
    const imported = await importFiles(service, [join(outside, 'cover.png')])
    expect(imported.failedFiles).toEqual([])
    expect(imported.importedFiles[0]?.name).toBe('cover.png')
    expect(await readFile(join(root, 'assets/cover.png'))).toEqual(png)
    const sourceKey = encodeStorageKey(imported.importedFiles[0]?.sourceId ?? '')
    expect(await readFile(join(root, 'assets', sourceKey, 'cover.png'))).toEqual(
      Buffer.concat([png, Buffer.from('new')])
    )

    await writeFile(join(root, 'assets/draft.png'), png)
    await writeFile(join(outside, 'draft.png'), Buffer.concat([png, Buffer.from('draft')]))
    const draft = await importFiles(service, [join(outside, 'draft.png')])
    expect(draft.failedFiles).toEqual([])
    expect(await readFile(join(root, 'assets/draft.png'))).toEqual(png)
  })

  it('创建文件夹和文本，复制移动后删除副本不影响原件', async () => {
    const root = await temporaryDirectory('opengalgame-file-catalog-')
    await seedRepository(root)
    const service = await createService(root, [])
    const before = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(before.folders).toEqual([])
    expect(before.sources).toEqual([])
    await expect(readFile(join(root, '.opengalgame/inputs/catalog.json'), 'utf8')).rejects.toThrow()

    const folder = await service.createProjectFolder({
      projectId: 'project-1',
      expectedCatalogVersion: before.catalogVersion,
      parentFolderId: null,
      name: '资料'
    })
    const listed = await (
      await createService(root, [])
    ).listProjectInputSources({
      projectId: 'project-1'
    })
    expect(listed.folders).toEqual([folder])

    await expect(
      service.createProjectTextFile({
        projectId: 'project-1',
        expectedCatalogVersion: listed.catalogVersion,
        parentFolderId: folder.folderId,
        fileName: '笔记.md',
        content: { textKind: 'document', format: 'markdown', body: '' }
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.blankSourceContent })

    const created = await service.createProjectTextFile({
      projectId: 'project-1',
      expectedCatalogVersion: listed.catalogVersion,
      parentFolderId: folder.folderId,
      fileName: '笔记.md',
      content: { textKind: 'document', format: 'markdown', body: '# 正文' }
    })
    const read = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: [created.sourceId]
    })
    expect(read.sources[0]).toMatchObject({ body: '# 正文', title: '笔记.md' })

    const afterCreate = await service.listProjectInputSources({ projectId: 'project-1' })
    const copied = await service.copyProjectFile({
      projectId: 'project-1',
      operationId: 'copy-note',
      expectedCatalogVersion: afterCreate.catalogVersion,
      sourceId: created.sourceId,
      targetFolderId: null
    })
    expect(copied.sourceId).not.toBe(created.sourceId)
    const other = await service.createProjectFolder({
      projectId: 'project-1',
      expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
        .catalogVersion,
      parentFolderId: null,
      name: '另一处'
    })
    const moved = await service.moveProjectFile({
      projectId: 'project-1',
      operationId: 'move-note',
      expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
        .catalogVersion,
      sourceId: copied.sourceId,
      expectedParentFolderId: null,
      targetFolderId: other.folderId
    })
    expect(moved.sourceId).toBe(copied.sourceId)
    expect(moved.parentFolderId).toBe(other.folderId)

    await service.deleteProjectFile({
      projectId: 'project-1',
      expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
        .catalogVersion,
      sourceId: copied.sourceId
    })
    const original = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: [created.sourceId]
    })
    expect(original.sources[0]).toMatchObject({ body: '# 正文' })

    const nested = await service.createProjectFolder({
      projectId: 'project-1',
      expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
        .catalogVersion,
      parentFolderId: folder.folderId,
      name: '子目录'
    })
    const copiedFolder = await service.copyProjectFolder({
      projectId: 'project-1',
      operationId: 'copy-folder',
      expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
        .catalogVersion,
      folderId: nested.folderId,
      targetFolderId: null
    })
    expect(copiedFolder.name).toBe('子目录')
    expect(copiedFolder.folderId).not.toBe(nested.folderId)
    await expect(
      service.copyProjectFolder({
        projectId: 'project-1',
        operationId: 'copy-into-child',
        expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
          .catalogVersion,
        folderId: folder.folderId,
        targetFolderId: nested.folderId
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.illegalCopyTarget })

    const plan = await service.readProjectFolderDeletionPlan({
      projectId: 'project-1',
      folderId: folder.folderId
    })
    expect(plan.fileCount).toBe(1)
    expect(plan.folderCount).toBe(2)
    await service.deleteProjectFolder({
      projectId: 'project-1',
      expectedCatalogVersion: plan.catalogVersion,
      folderId: folder.folderId,
      expectedDeletionVersion: plan.deletionVersion
    })
    const cleared = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(cleared.folders.map((item) => item.folderId).sort()).toEqual(
      [other.folderId, copiedFolder.folderId].sort()
    )
    expect(cleared.sources).toEqual([])
    expect(moved.sourceId).not.toBe(created.sourceId)
  })

  it('保存正文写入正文文件，过期版本不覆盖', async () => {
    const root = await temporaryDirectory('opengalgame-file-body-')
    await seedRepository(root)
    const service = await createService(root, [])
    const created = await service.createProjectTextFile({
      projectId: 'project-1',
      expectedCatalogVersion: (await service.listProjectInputSources({ projectId: 'project-1' }))
        .catalogVersion,
      parentFolderId: null,
      fileName: '正文.md',
      content: { textKind: 'document', format: 'markdown', body: '# 初稿' }
    })
    const first = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: [created.sourceId]
    })
    expect(first.sources[0]).toMatchObject({ body: '# 初稿' })
    const staleVersion = first.sources[0]?.version ?? ''
    const bodyPath = join(
      root,
      `.opengalgame/inputs/documents/${encodeStorageKey(created.sourceId)}.md`
    )

    const updated = await service.updateProjectTextFileBody({
      projectId: 'project-1',
      sourceId: created.sourceId,
      expectedSourceVersion: staleVersion,
      content: { textKind: 'document', body: '# 二稿\n\n新段落' }
    })
    expect(updated).toMatchObject({ sourceId: created.sourceId, body: '# 二稿\n\n新段落' })
    expect(updated.version).not.toBe(staleVersion)
    expect(await readFile(bodyPath, 'utf8')).toBe('# 二稿\n\n新段落')
    const after = await service.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: [created.sourceId]
    })
    expect(after.sources[0]).toMatchObject({
      body: '# 二稿\n\n新段落',
      version: updated.version
    })

    const emptied = await service.updateProjectTextFileBody({
      projectId: 'project-1',
      sourceId: created.sourceId,
      expectedSourceVersion: updated.version,
      content: { textKind: 'document', body: '' }
    })
    expect(emptied.body).toBe('')
    expect(await readFile(bodyPath, 'utf8')).toBe('')

    await expect(
      service.updateProjectTextFileBody({
        projectId: 'project-1',
        sourceId: created.sourceId,
        expectedSourceVersion: staleVersion,
        content: { textKind: 'document', body: '# 不应写入' }
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.textBodyChanged })
    expect(await readFile(bodyPath, 'utf8')).toBe('')
  })

  it('越界素材路径不能打开或重命名', async () => {
    const root = await temporaryDirectory('opengalgame-file-escape-')
    const outside = await temporaryDirectory('opengalgame-file-escape-src-')
    await seedRepository(root)
    const secret = 'secret-outside'
    const outsideFile = join(outside, 'outside.txt')
    await writeFile(outsideFile, secret)
    const opened: string[] = []
    const service = await createService(root, opened)
    await writeSource(root, 'absolute', outsideFile.replaceAll('\\', '/'))
    await writeSource(root, 'parent', 'assets/../../outside.txt')
    await expect(
      service.openProjectFile({ projectId: 'project-1', sourceId: 'absolute' })
    ).rejects.toBeInstanceOf(Error)
    await expect(
      service.renameProjectFile({
        projectId: 'project-1',
        sourceId: 'parent',
        newFileName: 'renamed.png',
        expectedCatalogVersion: 'unused'
      })
    ).rejects.toBeInstanceOf(Error)
    expect(opened).toEqual([])
    expect(await readFile(outsideFile, 'utf8')).toBe(secret)
  })

  it('后写入的目录不会盖掉先提交的文件夹', async () => {
    const root = await temporaryDirectory('opengalgame-catalog-race-')
    await seedRepository(root)
    const service = await createService(root, [], gatewayThatCommitsFolderFirst(root))
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    await expect(
      service.createProjectFolder({
        projectId: 'project-1',
        parentFolderId: null,
        name: '后到',
        expectedCatalogVersion: listed.catalogVersion
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.catalogVersionChanged })
    const after = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(after.folders.map((folder) => folder.name)).toEqual(['先完成'])
  })

  it('导入进行中另建的文件夹仍在，这次导入失败', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000020001e221bc330000000049454e44ae426082',
      'hex'
    )
    const root = await temporaryDirectory('opengalgame-import-race-')
    const outside = await temporaryDirectory('opengalgame-import-race-src-')
    await seedRepository(root)
    await writeFile(join(outside, 'town.png'), png)
    const service = await createService(root, [], gatewayThatCommitsFolderFirst(root))
    const imported = await importFiles(service, [join(outside, 'town.png')])
    expect(imported.importedFiles).toEqual([])
    expect(imported.failedFiles).toHaveLength(1)
    const after = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(after.folders.map((folder) => folder.name)).toEqual(['先完成'])
    expect(after.sources).toEqual([])
  })

  it('连续导入两项都使用各自提交后的目录版本', async () => {
    const root = await temporaryDirectory('opengalgame-import-two-')
    const outside = await temporaryDirectory('opengalgame-import-two-src-')
    await seedRepository(root)
    await writeFile(join(outside, 'a.txt'), '甲', 'utf8')
    await writeFile(join(outside, 'b.txt'), '乙', 'utf8')
    const service = await createService(root, [])
    const imported = await importFiles(service, [join(outside, 'a.txt'), join(outside, 'b.txt')])
    expect(imported.failedFiles).toEqual([])
    expect(imported.importedFiles.map((file) => file.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('场景仍引用的素材路径不能删除', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000020001e221bc330000000049454e44ae426082',
      'hex'
    )
    const root = await temporaryDirectory('opengalgame-scene-ref-')
    await seedRepository(root)
    const mediaPath = 'assets/background/town.png'
    await mkdir(join(root, 'assets/background'), { recursive: true })
    await mkdir(join(root, 'game/scene'), { recursive: true })
    await writeFile(join(root, mediaPath), png)
    await writeFile(join(root, 'game/scene/start.txt'), 'changeBg:town.png;\n', 'utf8')
    await writeSource(root, 'town-bg', mediaPath, 'town.png')
    const service = await createService(root, [])
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    const source = listed.sources.find((item) => item.sourceId === 'town-bg')
    expect(source).toBeDefined()
    await expect(
      service.deleteProjectFile({
        projectId: 'project-1',
        sourceId: 'town-bg',
        expectedCatalogVersion: listed.catalogVersion
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.contentReferenceConflict })
    expect(await readFile(join(root, mediaPath))).toEqual(png)
    expect(await readFile(join(root, 'game/scene/start.txt'), 'utf8')).toBe('changeBg:town.png;\n')
  })

  it('删除工程内符号链接内容，不留下链接文件', async () => {
    const root = await temporaryDirectory('opengalgame-symlink-')
    await seedRepository(root)
    await mkdir(join(root, 'assets/background'), { recursive: true })
    const link = join(root, 'assets/background/town.png')
    await symlink(join(root, 'assets/keep/missing.png'), link)
    await writeSource(root, 'link-bg', 'assets/background/town.png', 'town.png')
    const author = {
      name: 'opengalgame',
      email: 'opengalgame@localhost',
      timestamp: 2,
      timezoneOffset: 0
    }
    await git.add({ fs, dir: root, filepath: 'assets/background/town.png' })
    await git.add({
      fs,
      dir: root,
      filepath: `.opengalgame/inputs/sources/${encodeStorageKey('link-bg')}.json`
    })
    await git.commit({ fs, dir: root, message: '链入素材', author, committer: author })
    const service = await createService(root, [])
    const listed = await service.listProjectInputSources({ projectId: 'project-1' })
    await expect(
      service.deleteProjectFile({
        projectId: 'project-1',
        sourceId: 'link-bg',
        expectedCatalogVersion: listed.catalogVersion
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.fileOperationFailed })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    const after = await service.listProjectInputSources({ projectId: 'project-1' })
    expect(after.sources.find((item) => item.sourceId === 'link-bg')).toBeDefined()
  })
})

async function importFiles(
  service: ProjectFilesApplicationServiceImpl,
  localFilePaths: readonly string[]
) {
  const catalog = await service.listProjectInputSources({ projectId: 'project-1' })
  return service.importProjectFiles({
    projectId: 'project-1',
    parentFolderId: null,
    expectedCatalogVersion: catalog.catalogVersion,
    localFilePaths
  })
}

function gatewayThatCommitsFolderFirst(root: string): ProjectFileOperationGateway {
  const inner = new LocalProjectFileOperationGatewayImpl()
  let started = false
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'prepareCatalogWrite') {
        return async (
          project: Parameters<ProjectFileOperationGateway['prepareCatalogWrite']>[0],
          catalog: Parameters<ProjectFileOperationGateway['prepareCatalogWrite']>[1]
        ) => {
          if (!started) {
            started = true
            const other = await createService(root, [], undefined, 'other-')
            const listed = await other.listProjectInputSources({ projectId: 'project-1' })
            await other.createProjectFolder({
              projectId: 'project-1',
              parentFolderId: null,
              name: '先完成',
              expectedCatalogVersion: listed.catalogVersion
            })
          }
          return target.prepareCatalogWrite(project, catalog)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

async function writeSource(
  root: string,
  sourceId: string,
  mediaPath: string,
  name = '越界.png'
): Promise<void> {
  const key = encodeStorageKey(sourceId)
  await mkdir(join(root, '.opengalgame/inputs/sources'), { recursive: true })
  await writeFile(
    join(root, `.opengalgame/inputs/sources/${key}.json`),
    JSON.stringify({
      formatVersion: 1,
      projectId: 'project-1',
      sourceId,
      content: {
        kind: 'asset',
        name,
        fileType: 'image',
        description: '',
        fileId: sourceId,
        mediaPath
      }
    })
  )
}
