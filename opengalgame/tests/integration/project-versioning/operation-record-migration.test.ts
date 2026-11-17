import * as fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as git from 'isomorphic-git'

import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

const directories: string[] = []
const text = new TextEncoder()

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('legacy 操作记录首访归档归一后，提交/查询/回退与未涉及暂存项保持', async () => {
  const world = await seededProject('原始')
  const stagedPath = join(world.projectRoot, 'staged.txt')
  await writeFile(stagedPath, '暂存旁路')
  await git.add({ fs, dir: world.projectRoot, filepath: 'staged.txt' })
  const stagedStatus = await git.status({
    fs,
    dir: world.projectRoot,
    filepath: 'staged.txt'
  })
  expect(stagedStatus).toBe('added')

  const first = serviceFor(world.userDirectory, ['op-1', 'hist-1'])
  const prepared = await first.prepareOperation({
    projectId: 'project-1',
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene', id: 'scene-1' }],
    changePaths: ['story.txt'],
    watchedPaths: ['watch.txt']
  })
  const committed = await commitStory(first, 'op-1', prepared.baselineRef, '新章节')
  expect(committed.state).toBe('已提交')
  expect(await git.status({ fs, dir: world.projectRoot, filepath: 'staged.txt' })).toBe(
    stagedStatus
  )
  await expect(readFile(stagedPath, 'utf8')).resolves.toBe('暂存旁路')

  const recordPath = join(world.projectRoot, '.git', 'opengalgame', 'operations', 'op-1.json')
  const currentRecord = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
  const legacyBytes = Buffer.from(
    JSON.stringify({
      ...currentRecord,
      rollbackIndexBytesBase64: Buffer.from('legacy-rollback-index').toString('base64')
    }),
    'utf8'
  )
  await writeFile(recordPath, legacyBytes)

  const restarted = serviceFor(world.userDirectory, [])
  await expect(
    restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-1' })
  ).resolves.toMatchObject({ state: '已提交', revisionRef: committed.revisionRef })

  const archiveRoot = join(world.projectRoot, '.git', 'opengalgame', 'legacy-operations')
  const archiveNames = await readdir(archiveRoot)
  expect(archiveNames).toHaveLength(1)
  const archiveDirectory = join(archiveRoot, archiveNames[0]!)
  expect(
    await readFile(join(archiveDirectory, 'files/project-0/.git/opengalgame/operations/op-1.json'))
  ).toEqual(legacyBytes)
  const normalized = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
  expect(normalized).toMatchObject({ formatVersion: 1, operationId: 'op-1' })
  expect(Object.hasOwn(normalized, 'rollbackIndexBytesBase64')).toBe(false)
  expect(await git.status({ fs, dir: world.projectRoot, filepath: 'staged.txt' })).toBe(
    stagedStatus
  )

  const page = await restarted.listHistory({ projectId: 'project-1', pageSize: 10 })
  expect(page.entries[0]).toMatchObject({ historyId: 'hist-1', state: '已提交' })
  const rolled = await restarted.rollbackOperation({
    projectId: 'project-1',
    operationId: 'op-1'
  })
  expect(rolled.state).toBe('已回退')
  await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
  expect(await git.status({ fs, dir: world.projectRoot, filepath: 'staged.txt' })).toBe(
    stagedStatus
  )
  await expect(readFile(stagedPath, 'utf8')).resolves.toBe('暂存旁路')
  const repeated = await restarted.rollbackOperation({
    projectId: 'project-1',
    operationId: 'op-1'
  })
  expect(repeated.revisionRef).toBe(rolled.revisionRef)

  const after = serviceFor(world.userDirectory, ['op-2', 'hist-2'])
  const preparedAgain = await after.prepareOperation({
    projectId: 'project-1',
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene', id: 'scene-1' }],
    changePaths: ['story.txt'],
    watchedPaths: ['watch.txt']
  })
  const committedAgain = await commitStory(after, 'op-2', preparedAgain.baselineRef, '回退后新章节')
  expect(committedAgain.state).toBe('已提交')
  await expect(
    after.readOperationSettlement({ projectId: 'project-1', operationId: 'op-2' })
  ).resolves.toMatchObject({ state: '已提交', revisionRef: committedAgain.revisionRef })
  expect(await git.status({ fs, dir: world.projectRoot, filepath: 'staged.txt' })).toBe(
    stagedStatus
  )
  await expect(readFile(stagedPath, 'utf8')).resolves.toBe('暂存旁路')
})

it('非法旧字段查询保留待核对，源记录字节不变且不生成归档', async () => {
  const world = await seededProject('原始')
  const first = serviceFor(world.userDirectory, ['op-bad', 'hist-bad'])
  const prepared = await first.prepareOperation({
    projectId: 'project-1',
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene', id: 'scene-1' }],
    changePaths: ['story.txt'],
    watchedPaths: []
  })
  const committed = await commitStory(first, 'op-bad', prepared.baselineRef, '新章节')
  expect(committed.state).toBe('已提交')

  const recordPath = join(world.projectRoot, '.git', 'opengalgame', 'operations', 'op-bad.json')
  const invalidBytes = Buffer.from(
    JSON.stringify({
      ...(JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>),
      rollbackIndexBytesBase64: '***not-base64***'
    }),
    'utf8'
  )
  await writeFile(recordPath, invalidBytes)

  const restarted = serviceFor(world.userDirectory, [])
  await expect(
    restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-bad' })
  ).resolves.toMatchObject({ state: '待核对' })
  expect(await readFile(recordPath)).toEqual(invalidBytes)
  await expect(
    readdir(join(world.projectRoot, '.git', 'opengalgame', 'legacy-operations'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function seededProject(content: string): Promise<{
  userDirectory: string
  projectRoot: string
}> {
  const root = await temporaryDirectory('opengalgame-r32-versioning-')
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(projectRoot)
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  await writeFile(join(projectRoot, 'story.txt'), content)
  await writeFile(join(projectRoot, 'watch.txt'), '观察')
  await createProjectVersioningGateways(userDirectory).transactions.initializeBaseline({
    projectId: 'project-1',
    initialPaths: ['story.txt', 'watch.txt']
  })
  return { userDirectory, projectRoot }
}

function serviceFor(
  userDirectory: string,
  ids: readonly string[]
): ManageProjectVersioning {
  const remaining = [...ids]
  const gateways = createProjectVersioningGateways(userDirectory)
  return new ManageProjectVersioning({
    ...gateways,
    nextId: () => {
      const next = remaining.shift()
      if (!next) throw new Error('测试身份已用尽')
      return next
    }
  })
}

function commitStory(
  versioning: ManageProjectVersioning,
  operationId: string,
  baselineRef: string,
  content: string
): Promise<{ operationId: string; state: '已提交' | '无变更'; revisionRef: string }> {
  return versioning.commitOperation(
    {
      projectId: 'project-1',
      operationId,
      baselineRef,
      input: {
        kind: 'files',
        changes: [
          {
            relativePath: 'story.txt',
            action: 'modify',
            content: { kind: 'bytes', bytes: text.encode(content) }
          }
        ]
      },
      saveMode: 'manual',
      contentSource: 'operation',
      title: '保存章节',
      summary: '更新正文'
    },
    () => undefined
  )
}
