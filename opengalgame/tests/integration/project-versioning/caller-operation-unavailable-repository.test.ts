import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

it('失效登记不阻断调用方扫描，跨工程冲突仍返回 4103', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caller-scan-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const validRoot = join(root, 'valid')
  const plainRoot = join(root, 'plain')
  const otherRoot = join(root, 'other')
  await mkdir(userDirectory)
  await mkdir(validRoot)
  await mkdir(plainRoot)
  await mkdir(otherRoot)
  await writeFile(join(validRoot, 'story.txt'), '有效')
  await writeFile(join(otherRoot, 'story.txt'), '另一份')
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-valid', directory: validRoot, operationId: 'op-valid' },
    { id: 'project-plain', directory: plainRoot, operationId: 'op-plain' },
    { id: 'project-other', directory: otherRoot, operationId: 'op-other' }
  ])
  const gateways = createProjectVersioningGateways(userDirectory)
  await gateways.transactions.initializeBaseline({
    projectId: 'project-valid',
    initialPaths: ['story.txt']
  })
  await gateways.transactions.initializeBaseline({
    projectId: 'project-other',
    initialPaths: ['story.txt']
  })
  const valid = await prepareAndBind(
    userDirectory,
    'project-valid',
    'caller-valid',
    'version-valid'
  )
  const missing = await gateways.records.findCallerOperation('scene-canvas', 'caller-missing')
  expect(missing).toBeNull()
  expect(valid.projectId).toBe('project-valid')
  await prepareAndBind(userDirectory, 'project-other', 'caller-conflict', 'version-other')
  const bound = await rejectionOf(
    prepareAndBind(userDirectory, 'project-valid', 'caller-conflict', 'version-valid-conflict')
  )
  expect(bound.code).toBe(ErrorCodes.operationConflict)
  const existing = await gateways.records.findCallerOperation('scene-canvas', 'caller-conflict')
  expect(existing?.projectId).toBe('project-other')
})

it('.git 为文件时不阻断扫描，有效链接仍可解析，跨工程冲突仍返回 4103', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caller-git-file-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const validRoot = join(root, 'valid')
  const fileGitRoot = join(root, 'file-git')
  const missingGitRoot = join(root, 'missing-git')
  const otherRoot = join(root, 'other')
  await mkdir(userDirectory)
  await mkdir(validRoot)
  await mkdir(fileGitRoot)
  await mkdir(missingGitRoot)
  await mkdir(otherRoot)
  await writeFile(join(validRoot, 'story.txt'), '有效')
  await writeFile(join(otherRoot, 'story.txt'), '另一份')
  await writeFile(join(fileGitRoot, '.git'), 'gitdir: /outside/worktree.git\n')
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-valid', directory: validRoot, operationId: 'op-valid' },
    { id: 'project-file-git', directory: fileGitRoot, operationId: 'op-file-git' },
    { id: 'project-missing-git', directory: missingGitRoot, operationId: 'op-missing-git' },
    { id: 'project-other', directory: otherRoot, operationId: 'op-other' }
  ])
  const gateways = createProjectVersioningGateways(userDirectory)
  await gateways.transactions.initializeBaseline({
    projectId: 'project-valid',
    initialPaths: ['story.txt']
  })
  await gateways.transactions.initializeBaseline({
    projectId: 'project-other',
    initialPaths: ['story.txt']
  })
  const valid = await prepareAndBind(
    userDirectory,
    'project-valid',
    'caller-valid',
    'version-valid'
  )
  expect(valid.projectId).toBe('project-valid')
  await expect(
    gateways.records.findCallerOperation('scene-canvas', 'caller-missing')
  ).resolves.toBeNull()
  await prepareAndBind(userDirectory, 'project-other', 'caller-conflict', 'version-other')
  const bound = await rejectionOf(
    prepareAndBind(userDirectory, 'project-valid', 'caller-conflict', 'version-valid-conflict')
  )
  expect(bound.code).toBe(ErrorCodes.operationConflict)
})

it('.git 为符号链接或 junction 时视为无调用方链接并继续扫描', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caller-git-link-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const validRoot = join(root, 'valid')
  const linkedRoot = join(root, 'linked')
  const outside = join(root, 'outside')
  await mkdir(userDirectory)
  await mkdir(validRoot)
  await mkdir(linkedRoot)
  await mkdir(outside)
  await writeFile(join(validRoot, 'story.txt'), '有效')
  await symlink(outside, join(linkedRoot, '.git'), 'junction')
  expect((await lstat(join(linkedRoot, '.git'))).isSymbolicLink()).toBe(true)
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-valid', directory: validRoot, operationId: 'op-valid' },
    { id: 'project-linked', directory: linkedRoot, operationId: 'op-linked' }
  ])
  const gateways = createProjectVersioningGateways(userDirectory)
  await gateways.transactions.initializeBaseline({
    projectId: 'project-valid',
    initialPaths: ['story.txt']
  })
  const valid = await prepareAndBind(
    userDirectory,
    'project-valid',
    'caller-linked',
    'version-linked'
  )
  expect(valid.projectId).toBe('project-valid')
})

async function prepareAndBind(
  userDirectory: string,
  projectId: string,
  callerOperationId: string,
  operationId: string
): Promise<{ projectId: string; operationId: string }> {
  const records = createProjectVersioningGateways(userDirectory).records
  await records.bindPrepared({
    projectId,
    operationId,
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene', id: 'scene-1' }],
    changePaths: ['story.txt'],
    watchedPaths: [],
    baselineRef: 'baseline',
    revisionRef: 'revision'
  })
  await records.bindCallerOperation({
    projectId,
    sourceModule: 'scene-canvas',
    callerOperationId,
    operationId,
    targets: [{ kind: 'scene', id: 'scene-1' }],
    changePaths: ['story.txt'],
    watchedPaths: []
  })
  const link = await records.findCallerOperation('scene-canvas', callerOperationId)
  if (!link) throw new Error('有效链接应当可解析')
  return link
}

async function rejectionOf(operation: Promise<unknown>): Promise<AppException> {
  try {
    await operation
  } catch (error) {
    return error as AppException
  }
  throw new Error('操作应当失败')
}
