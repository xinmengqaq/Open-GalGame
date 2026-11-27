import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import type * as ProjectWorkRootModule from '@infrastructure/project-versioning/projectWorkRoot'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

vi.mock('@infrastructure/project-versioning/projectWorkRoot', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectWorkRootModule>()
  return {
    ...actual,
    resolveProjectWorkRoot: async (userDirectory: string, projectId: string) => {
      if (projectId === 'project-denied') {
        throw new AppException({
          code: ProjectVersioningErrorCodes.gitUnavailable,
          msg: '工程暂时无法访问',
          cause: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        })
      }
      return actual.resolveProjectWorkRoot(userDirectory, projectId)
    }
  }
})

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

it('失效登记被跳过时，权限错误不会被当作不存在', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caller-permission-'))
  directories.push(root)
  const userDirectory = join(root, 'user')
  const validRoot = join(root, 'valid')
  const missingRoot = join(root, 'removed-project')
  const deniedRoot = join(root, 'denied')
  await mkdir(userDirectory)
  await mkdir(validRoot)
  await mkdir(deniedRoot)
  await writeFile(join(validRoot, 'story.txt'), '有效')
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-missing', directory: missingRoot, operationId: 'op-missing' },
    { id: 'project-valid', directory: validRoot, operationId: 'op-valid' },
    { id: 'project-denied', directory: deniedRoot, operationId: 'op-denied' }
  ])
  const gateways = createProjectVersioningGateways(userDirectory)
  await gateways.transactions.initializeBaseline({
    projectId: 'project-valid',
    initialPaths: ['story.txt']
  })

  const failure = await gateways.records
    .findCallerOperation('scene-canvas', 'caller-check')
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AppException)
  expect(failure).toMatchObject({ code: ProjectVersioningErrorCodes.gitUnavailable })
  expect((failure as AppException).cause).toMatchObject({ code: 'EACCES' })
})
