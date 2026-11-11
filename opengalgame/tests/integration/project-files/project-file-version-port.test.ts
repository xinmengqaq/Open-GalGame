import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('工程文件版本窄端口', () => {
  it('内联字节经版本服务进入作品，范围外和观察路径保持原样', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'keep.txt'), '保留')
    await writeFile(join(world.projectRoot, 'watch.txt'), '观察')
    const versioning = versioningFor(world.userDirectory, ['op-file', 'hist-file'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['keep.txt', 'watch.txt']
    })
    const gateway = new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v1')

    await gateway.publish({
      project: located(world.projectRoot),
      operationId: 'caller-op',
      changes: [
        {
          relativePath: 'notes.txt',
          action: 'add',
          bytes: new TextEncoder().encode('正文')
        }
      ],
      watchedPaths: ['watch.txt'],
      expectedCatalogVersion: 'catalog-v1'
    })

    await expect(readFile(join(world.projectRoot, 'notes.txt'), 'utf8')).resolves.toBe('正文')
    await expect(readFile(join(world.projectRoot, 'keep.txt'), 'utf8')).resolves.toBe('保留')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    await expect(gateway.readOperation(located(world.projectRoot), 'caller-op')).resolves.toBe(
      'committed'
    )
    const history = await versioning.listHistory({ projectId: 'project-1', pageSize: 10 })
    expect(history.entries).toEqual([
      expect.objectContaining({
        historyId: 'hist-file',
        sourceModule: 'project-files',
        title: '更新工程文件',
        summary: '已保存声明的工程文件变更',
        saveMode: 'manual',
        contentSource: 'operation',
        state: '已提交'
      })
    ])
  })

  it('同一调用方身份在新进程仍读到已提交，换工程或内容则拒绝', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'keep.txt'), '保留')
    const versioning = versioningFor(world.userDirectory, ['op-bind', 'hist-bind'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['keep.txt']
    })
    const gateway = new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v1')
    const request = {
      project: located(world.projectRoot),
      operationId: 'caller-bind',
      changes: [
        {
          relativePath: 'notes.txt',
          action: 'add' as const,
          bytes: new TextEncoder().encode('正文')
        }
      ],
      expectedCatalogVersion: 'catalog-v1'
    }
    await gateway.publish(request)

    const restarted = new LocalProjectWorkVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-unused', 'hist-unused']),
      async () => 'catalog-v1'
    )
    await expect(restarted.readOperation(located(world.projectRoot), 'caller-bind')).resolves.toBe(
      'committed'
    )
    await restarted.publish(request)
    await expect(versioning.listHistory({ projectId: 'project-1', pageSize: 10 })).resolves.toEqual(
      { entries: [expect.objectContaining({ historyId: 'hist-bind' })], nextCursor: null }
    )

    await expect(
      restarted.publish({
        ...request,
        changes: [
          {
            relativePath: 'other.txt',
            action: 'add',
            bytes: new TextEncoder().encode('另一份')
          }
        ]
      })
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    await expect(readFile(join(world.projectRoot, 'other.txt'), 'utf8')).rejects.toThrow()

    const otherRoot = join(world.userDirectory, 'other-project')
    await mkdir(otherRoot)
    await writeFile(join(otherRoot, 'keep.txt'), '另一工程')
    await writeProjectRegistrations(world.userDirectory, [
      { id: 'project-1', directory: world.projectRoot, operationId: 'op-register' },
      { id: 'project-2', directory: otherRoot, operationId: 'op-register-2' }
    ])
    const otherVersioning = versioningFor(world.userDirectory, ['op-other', 'hist-other'])
    await otherVersioning.initializeBaseline({ projectId: 'project-2', initialPaths: ['keep.txt'] })
    const otherGateway = new LocalProjectWorkVersionGatewayImpl(
      otherVersioning,
      async () => 'catalog-v1'
    )
    await expect(
      otherGateway.publish({
        ...request,
        project: { projectId: 'project-2', location: { directory: otherRoot } }
      })
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    await expect(restarted.readOperation(located(world.projectRoot), 'never-seen')).resolves.toBe(
      'unsettled'
    )
  })

  it('目录版本变化或观察路径被改动时拒绝，且不留下新文件', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'watch.txt'), '观察')
    const versioning = versioningFor(world.userDirectory, ['op-catalog', 'hist-catalog'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['watch.txt']
    })
    const stale = new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v2')
    await expect(
      stale.publish({
        project: located(world.projectRoot),
        operationId: 'caller-stale',
        changes: [
          {
            relativePath: 'notes.txt',
            action: 'add',
            bytes: new TextEncoder().encode('不该写入')
          }
        ],
        expectedCatalogVersion: 'catalog-v1'
      })
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.catalogVersionChanged })
    await expect(readFile(join(world.projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow()

    await writeFile(join(world.projectRoot, 'watch.txt'), '外部改动')
    const drifted = new LocalProjectWorkVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-drift', 'hist-drift']),
      async () => 'catalog-v1'
    )
    await expect(
      drifted.publish({
        project: located(world.projectRoot),
        operationId: 'caller-drift',
        changes: [
          {
            relativePath: 'notes.txt',
            action: 'add',
            bytes: new TextEncoder().encode('仍不该写入')
          }
        ],
        watchedPaths: ['watch.txt'],
        expectedCatalogVersion: 'catalog-v1'
      })
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    await expect(readFile(join(world.projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('外部改动')
  })

  it('来源文件按内联字节提交，缺少字节时不能假成功', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'keep.txt'), '保留')
    const source = join(world.userDirectory, 'incoming.bin')
    await writeFile(source, '素材字节')
    const versioning = versioningFor(world.userDirectory, ['op-bytes', 'hist-bytes'])
    await versioning.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['keep.txt']
    })
    const gateway = new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v1')
    await gateway.publish({
      project: located(world.projectRoot),
      operationId: 'caller-bytes',
      changes: [{ relativePath: 'assets/incoming.bin', action: 'add', sourceFile: source }],
      expectedCatalogVersion: 'catalog-v1'
    })
    await expect(readFile(join(world.projectRoot, 'assets/incoming.bin'), 'utf8')).resolves.toBe(
      '素材字节'
    )

    const missing = new LocalProjectWorkVersionGatewayImpl(
      versioningFor(world.userDirectory, ['op-missing', 'hist-missing']),
      async () => 'catalog-v1'
    )
    await expect(
      missing.publish({
        project: located(world.projectRoot),
        operationId: 'caller-missing',
        changes: [{ relativePath: 'assets/empty.bin', action: 'add' }],
        expectedCatalogVersion: 'catalog-v1'
      })
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.invalidContentFingerprint })
    await expect(readFile(join(world.projectRoot, 'assets/empty.bin'), 'utf8')).rejects.toThrow()
    await expect(missing.readOperation(located(world.projectRoot), 'op-missing')).resolves.toBe(
      'unsettled'
    )
  })

  it('版本结果不明或补偿失败时不报告提交成功', async () => {
    const project = located('D:/works/project-1')
    await expect(
      gatewayThatFails(
        new AppException({
          code: ProjectVersioningErrorCodes.insufficientEvidence,
          msg: '提交结果不明，不能重试'
        })
      ).publish(publishRequest(project))
    ).rejects.toMatchObject({ code: ProjectFileErrorCodes.commitUnclear })

    const compensate = gatewayThatFails(
      new AppException({
        code: ErrorCodes.internalError,
        msg: '作品提交失败，且恢复正式文件也失败'
      })
    )
    await expect(compensate.publish(publishRequest(project))).rejects.toMatchObject({
      code: ProjectFileErrorCodes.commitUnclear
    })
    await expect(compensate.readOperation(project, 'op-unclear')).resolves.toBe('unsettled')
  })
})

function gatewayThatFails(error: AppException): LocalProjectWorkVersionGatewayImpl {
  const versioning = {
    prepareOperation: async () => ({
      operationId: 'op-unclear',
      baselineRef: 'baseline-1',
      revisionRef: 'rev-1'
    }),
    readPreparedOperation: async () => ({
      operationId: 'op-unclear',
      baselineRef: 'baseline-1',
      revisionRef: 'rev-1'
    }),
    bindCallerOperation: async () => undefined,
    readCallerOperation: async () => null,
    findCallerOperation: async () => null,
    commitOperation: async (
      _request: unknown,
      requirePreconditions: () => void | Promise<void>
    ) => {
      await requirePreconditions()
      throw error
    },
    readOperationSettlement: async () => ({ operationId: 'op-unclear', state: '待核对' as const })
  } as ProjectVersioningApplicationService
  return new LocalProjectWorkVersionGatewayImpl(versioning, async () => 'catalog-v1')
}

function publishRequest(project: { projectId: string; location: { directory: string } }): {
  project: { projectId: string; location: { directory: string } }
  operationId: string
  changes: readonly {
    relativePath: string
    action: 'add'
    bytes: Uint8Array
  }[]
  expectedCatalogVersion: string
} {
  return {
    project,
    operationId: 'caller-unclear',
    changes: [
      {
        relativePath: 'notes.txt',
        action: 'add',
        bytes: new TextEncoder().encode('不明')
      }
    ],
    expectedCatalogVersion: 'catalog-v1'
  }
}

async function registeredProject(): Promise<{ userDirectory: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-file-version-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(projectRoot)
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  return { userDirectory, projectRoot }
}

function located(projectRoot: string): { projectId: string; location: { directory: string } } {
  return { projectId: 'project-1', location: { directory: projectRoot } }
}

function versioningFor(
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
