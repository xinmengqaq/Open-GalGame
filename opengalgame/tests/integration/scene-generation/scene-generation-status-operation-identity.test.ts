/**
 * I1：状态查询必须区分“操作确认不存在”与“操作存在但旧检查点读不出来”。
 *
 * 使用真实执行记录、真实旧检查点读取路径和公共 controller/client；
 * “不存在”来自仓储按操作标识查询返回 null；旧检查点记录仍在仓储中，
 * 只因检查点文件缺失而读取失败。不启动 Electron、浏览器或页面。
 */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'

import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import {
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const access = { trusted: true, requestId: 'status-operation-identity-test' }

function controllerFor(app: GenerationFixture['app']): SceneGenerationController {
  const logger: LoggerGateway = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  return new SceneGenerationController(
    {
      launch: app.launch,
      renderQuery: app.renderQuery,
      control: app.control,
      history: app.history,
      preview: app.candidatePreview,
      generation: app.generation
    } as unknown as SceneGenerationApplicationGateway,
    new IpcExceptionHandler(logger, new IpcErrorMapper())
  )
}

function clientFor(controller: SceneGenerationController): SceneGenerationClientImpl {
  return new SceneGenerationClientImpl({
    getSceneGenerationStatus: (value: unknown) => controller.status(value, access)
  } as unknown as DesktopBridge)
}

async function generateReviewed(base: GenerationFixture): Promise<SceneGenerationExecution> {
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const execution = await base.app.ports.executions.readExecution(request)
  if (!execution) throw new Error('执行记录不存在')
  return execution
}

it('操作确认不存在带结构化原因；旧检查点缺失仍为普通读取失败', async () => {
  const base = await generationFixture({ review: true })
  const execution = await generateReviewed(base)
  const client = clientFor(controllerFor(base.app))
  const scope: SceneGenerationScopeDTO = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: execution.operationId
  }

  const missing = await client.status({ ...scope, operationId: randomUUID() })
  expect(missing.code).toBe(ErrorCodes.invalidRequest)
  expect(missing.reason).toBe(FailureReasons.sceneGenerationOperationMissing)
  expect(missing.data).toBeUndefined()

  // 记录仍在仓储中，只把检查点指向一个不存在的旧格式检查点。
  const legacy = await base.app.ports.executions.writeExecution({
    ...execution,
    checkpointId: randomUUID()
  })
  const unreadable = await client.status({ ...scope, operationId: legacy.operationId })
  expect(unreadable.code).toBe(ErrorCodes.invalidRequest)
  expect(unreadable.reason).toBeUndefined()
  expect(unreadable.data).toBeUndefined()
  expect(await base.app.ports.executions.readExecution(scope)).not.toBeNull()
})

it('操作存在但场景身份不符返回 forbidden，不冒充不存在', async () => {
  const base = await generationFixture({ review: true })
  const execution = await generateReviewed(base)
  const client = clientFor(controllerFor(base.app))

  const mismatched = await client.status({
    projectId: request.projectId,
    sceneId: 'another-scene',
    operationId: execution.operationId
  })
  expect(mismatched.code).toBe(ErrorCodes.forbidden)
  expect(mismatched.reason).toBeUndefined()
})

it('通信失败保持 communicationFailed，不带操作缺失原因', async () => {
  const client = new SceneGenerationClientImpl({
    getSceneGenerationStatus: async () => {
      throw new Error('ipc closed')
    }
  } as unknown as DesktopBridge)

  const failed = await client.status({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: request.operationId
  })
  expect(failed.code).toBe(ErrorCodes.communicationFailed)
  expect(failed.reason).toBeUndefined()
})
