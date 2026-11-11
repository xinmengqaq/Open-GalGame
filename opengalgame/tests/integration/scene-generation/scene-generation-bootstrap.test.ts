import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'

const opengalgameRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('没有可用模型连接设置时仍能装配场景生成服务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-bootstrap-'))
  roots.push(root)

  const app = await createSceneGeneration({
    userStateRoot: join(root, 'state'),
    promptRoot: join(opengalgameRoot, 'resources/ai/prompts'),
    loadSettings: async () => null,
    dispatch: () => undefined,
    publishProgress: () => undefined,
    versioning: new ProjectVersioningApplicationServiceImpl({
      ...createProjectVersioningGateways(join(root, 'state')),
      nextId: randomUUID
    }),
    projects: {
      ensureProjectWorkspace: async () => {
        throw new Error('装配测试不启动生成')
      }
    }
  })

  expect(app.generation).toBeDefined()
  expect(app.status).toBeDefined()
  await app.close()
})
