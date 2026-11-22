import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import {
  EditSceneCanvas,
  type SceneCanvasApplicationDependencies
} from '@application/scene-canvas/services/impl/EditSceneCanvas'
import type { SaveSceneCanvasArrangementDTO } from '@application/scene-canvas/dto/SceneCanvasDTO'
import type { StartSceneGenerationDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { SceneCanvasClientImpl } from '@interfaces/scene-canvas/client/SceneCanvasClientImpl'
import { SceneCanvasController } from '@interfaces/scene-canvas/ipc/SceneCanvasController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import { SceneInputGatewayImpl } from '@infrastructure/scene-generation/inputs/SceneInputGatewayImpl'
import { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
import { SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION } from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'
import {
  documentBodyPath,
  encodeStorageKey,
  sourceDescriptorPath
} from '@infrastructure/project-files/projectFilePaths'
import {
  createWorkbenchCommands,
  type WorkbenchCommands
} from '@presentation/features/workbench-session/workbenchCommands'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import { promptReferenceFailureOf } from '@presentation/features/workbench-session/promptReferences'
import { failureOf, requireSuccess, type FailureState } from '@presentation/feedback/failure'
import type { AjaxResult } from '@common/contracts/AjaxResult'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

const A = '同一提示词不能重复引用同一卡片。'
const B = '提示词引用必须是当前画布中的其他卡片。'
const C = '提示词引用的卡片不在当前画布或无法读取。'
const layout = { x: 0, y: 0, width: 320, height: 252 }
const directories: string[] = []
let commands: WorkbenchCommands | null = null
let projectId = 0

type LogCall = {
  level: string
  event: string
  context?: LogContext
}

function loggerOf(): { logger: LoggerGateway; calls: LogCall[] } {
  const calls: LogCall[] = []
  return {
    calls,
    logger: {
      debug(event, context) {
        calls.push({ level: 'debug', event, context })
      },
      info(event, context) {
        calls.push({ level: 'info', event, context })
      },
      warn(event, context) {
        calls.push({ level: 'warn', event, context })
      },
      error(event, context) {
        calls.push({ level: 'error', event, context })
      }
    }
  }
}

function arrangement(references: readonly string[] = []): SceneCanvasArrangementVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'src-doc',
        title: '设定',
        summary: '',
        layout
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        body: '用 @ 作背景',
        references: references.map((cardId) => ({ cardId })),
        layout
      }
    ],
    relations: []
  }
}

function startWorkbenchSession(value: SceneCanvasArrangementVO = arrangement()): void {
  const store = useWorkbenchSessionStore.getState()
  store.reset()
  store.startSession({
    projectId: 'project-1',
    projectName: 'R19 基线',
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
  store.setArrangement(value)
}

function canvasController(logger: LoggerGateway): SceneCanvasController {
  return new SceneCanvasController(
    new EditSceneCanvas({} as unknown as SceneCanvasApplicationDependencies),
    new IpcExceptionHandler(logger, new IpcErrorMapper())
  )
}

function canvasClient(controller: SceneCanvasController): SceneCanvasClientImpl {
  return new SceneCanvasClientImpl({
    saveSceneCanvasArrangement: (request) =>
      controller.saveSceneCanvasArrangement(request, {
        trusted: true,
        requestId: 'r19-save'
      })
  } as unknown as DesktopBridge)
}

function failureFrom(result: AjaxResult<unknown>): FailureState {
  let caught: unknown
  try {
    requireSuccess(result)
  } catch (error) {
    caught = error
  }
  if (caught === undefined) throw new Error('预期失败响应')
  return failureOf(caught)
}

function generationRequest(): StartSceneGenerationDTO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    confirmedControls: [],
    policy: { maxCorrections: 1 }
  }
}

async function generationFailure(error: AppException): Promise<{
  result: AjaxResult<unknown>
  parsed: AjaxResult<unknown>
  failure: FailureState
  calls: LogCall[]
}> {
  const { logger, calls } = loggerOf()
  const handler = new IpcExceptionHandler(logger, new IpcErrorMapper())
  const services = {
    launch: {
      startSceneGeneration: async () => {
        throw error
      }
    }
  } as unknown as SceneGenerationApplicationGateway
  const controller = new SceneGenerationController(services, handler)
  const request = generationRequest()
  const result = await controller.start(request, { trusted: true, requestId: 'r19-4101' })
  const client = new SceneGenerationClientImpl({
    startSceneGeneration: async () => result
  } as unknown as DesktopBridge)
  const parsed = await client.start(request)
  return { result, parsed, failure: failureFrom(parsed), calls }
}

async function writeFixtureProject(
  options: {
    references?: readonly string[]
    promptBody?: string
  } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `opengalgame-r19-chain-${projectId++}-`))
  directories.push(root)
  const manifest = {
    formatVersion: 2,
    projectId: 'project-1',
    operationId: `op-${projectId}`
  }
  await writeRelative(root, '.opengalgame/manifest.json', `${JSON.stringify(manifest)}\n`)
  const sourceId = 'document-source'
  const key = encodeStorageKey(sourceId)
  await writeRelative(
    root,
    sourceDescriptorPath(sourceId),
    JSON.stringify({
      formatVersion: 1,
      projectId: 'project-1',
      sourceId,
      content: {
        kind: 'document',
        title: '设定',
        topics: ['角色'],
        importFormat: 'markdown',
        bodyFile: `${key}.md`
      }
    })
  )
  await writeRelative(root, documentBodyPath(sourceId, 'md'), '设定正文')
  const arrangementDocument = {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'document-card',
        sourceId,
        title: '设定',
        summary: '',
        usage: { targetIds: [] },
        layout: { x: 0, y: 0, width: 10, height: 10 }
      },
      {
        kind: 'prompt',
        cardId: 'prompt-card',
        title: 'prompt-card',
        summary: '',
        body: options.promptBody ?? '用人物作立绘',
        references: (options.references ?? []).map((cardId) => ({ cardId })),
        usage: { targetIds: [] },
        layout: { x: 20, y: 0, width: 10, height: 10 }
      }
    ],
    relations: []
  }
  await writeRelative(
    root,
    arrangementPath('scene-1', 'canvas-1'),
    JSON.stringify(arrangementDocument)
  )
  return root
}

async function generationInputError(options: {
  references?: readonly string[]
  promptBody?: string
}): Promise<AppException> {
  const root = await writeFixtureProject(options)
  const backupRoot = `${root}-migration`
  directories.push(backupRoot)
  const gateway = new SceneInputGatewayImpl(
    [
      {
        source: {
          projectId: 'project-1',
          sceneId: 'scene-1',
          projectRoot: root,
          sceneDirectory: 'game/scene',
          entryFile: 'start.txt'
        }
      }
    ],
    new CanvasArrangementMigration({ backupRoot })
  )
  const error = await gateway
    .readInputs(
      {
        projectId: 'project-1',
        sceneId: 'scene-1',
        projectRoot: root,
        sceneDirectory: 'game/scene',
        entryFile: 'start.txt'
      },
      { canvasId: 'canvas-1', confirmedControls: [] }
    )
    .then(
      () => null,
      (reason: unknown) => reason
    )
  if (!(error instanceof AppException)) throw new Error('预期生成输入失败')
  return error
}

async function writeRelative(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

beforeEach(() => {
  vi.mocked(toast).mockReset()
  startWorkbenchSession()
})

afterEach(async () => {
  commands?.dispose()
  commands = null
  useWorkbenchSessionStore.getState().reset()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('R19 提示词引用失败整链基线', () => {
  it('真实 4402 保存经过 controller/handler/client/commands，落到提示词卡 B', async () => {
    const { logger, calls } = loggerOf()
    commands = createWorkbenchCommands(canvasClient(canvasController(logger)))
    useWorkbenchSessionStore.getState().setPromptReferences('prompt', ['missing-card'])

    await commands.save('manual')

    expect(useWorkbenchSessionStore.getState().promptReferenceAlert).toEqual({ message: B })
    expect(useWorkbenchSessionStore.getState().saveError).toMatchObject({
      code: 4402,
      msg: '提示词引用必须是当前画布中的其他卡片',
      reason: FailureReasons.promptReferenceTargetMissing
    })
    expect(toast).toHaveBeenCalledWith(`保存失败（${B}）`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.context).toMatchObject({ errorCode: 4402 })
  })

  it('真实 4401 重复引用保存经过 controller/handler/client/commands，落到提示词卡 A', async () => {
    const { logger, calls } = loggerOf()
    startWorkbenchSession()
    const duplicate = arrangement(['doc', 'doc'])
    useWorkbenchSessionStore.getState().setArrangement(duplicate, { baseline: arrangement() })
    commands = createWorkbenchCommands(canvasClient(canvasController(logger)))

    await commands.save('manual')

    expect(useWorkbenchSessionStore.getState().promptReferenceAlert).toEqual({ message: A })
    expect(useWorkbenchSessionStore.getState().saveError).toMatchObject({
      code: 4401,
      reason: FailureReasons.promptReferenceDuplicate
    })
    expect(toast).toHaveBeenCalledWith(`保存失败（${A}）`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.context).toMatchObject({ errorCode: 4401 })
  })

  it('真实生成输入 4101 目标缺失经过 handler/client，落到提示词卡 C', async () => {
    const error = await generationInputError({ references: ['missing-card'] })
    expect(error).toMatchObject({
      code: ErrorCodes.invalidRequest,
      message: '提示词引用的卡片不在当前画布或无法读取',
      reason: FailureReasons.promptReferenceTargetMissing
    })
    const chain = await generationFailure(error)

    expect(chain.result).toMatchObject({
      code: ErrorCodes.invalidRequest,
      msg: '提示词引用的卡片不在当前画布或无法读取',
      reason: FailureReasons.promptReferenceTargetMissing
    })
    expect(chain.parsed).toMatchObject({
      code: ErrorCodes.invalidRequest,
      msg: '提示词引用的卡片不在当前画布或无法读取',
      reason: FailureReasons.promptReferenceTargetMissing
    })
    expect(promptReferenceFailureOf(chain.parsed)).toEqual({ text: C })
    expect(chain.failure).toMatchObject({
      code: ErrorCodes.invalidRequest,
      reason: FailureReasons.promptReferenceTargetMissing
    })
    expect(chain.calls).toHaveLength(1)
  })

  it('真实生成输入 4101 重复引用经过 handler/client，落到提示词卡 A', async () => {
    const error = await generationInputError({
      references: ['document-card', 'document-card']
    })
    expect(error).toMatchObject({
      code: ErrorCodes.invalidRequest,
      message: '同一提示词不能重复引用同一卡片',
      reason: FailureReasons.promptReferenceDuplicate
    })
    const chain = await generationFailure(error)

    expect(promptReferenceFailureOf(chain.parsed)).toEqual({ text: A })
    expect(chain.failure).toMatchObject({
      code: ErrorCodes.invalidRequest,
      reason: FailureReasons.promptReferenceDuplicate
    })
    expect(chain.calls).toHaveLength(1)
  })

  it('真实生成输入 4101 非引用错误不进入提示词卡', async () => {
    const error = await generationInputError({ promptBody: '' })
    expect(error).toMatchObject({
      code: ErrorCodes.invalidRequest,
      message: '提示词正文不能为空'
    })
    expect(error.reason).toBeUndefined()
    const chain = await generationFailure(error)

    expect(chain.parsed).not.toHaveProperty('reason')
    expect(promptReferenceFailureOf(chain.parsed)).toBeNull()
    expect(chain.calls).toHaveLength(1)
  })

  it('旧失败 payload 无 reason 仍通过真实 client schema，不退回通信失败', async () => {
    const legacy = {
      code: 4402,
      msg: '提示词引用必须是当前画布中的其他卡片'
    }
    const canvas = new SceneCanvasClientImpl({
      saveSceneCanvasArrangement: async () => legacy
    } as unknown as DesktopBridge)
    const parsedCanvas = await canvas.saveSceneCanvasArrangement(
      {} as SaveSceneCanvasArrangementDTO
    )
    expect(parsedCanvas).toEqual(legacy)

    const generation = new SceneGenerationClientImpl({
      startSceneGeneration: async () => ({
        code: ErrorCodes.invalidRequest,
        msg: '提示词引用的卡片不在当前画布或无法读取'
      })
    } as unknown as DesktopBridge)
    const parsedGeneration = await generation.start(generationRequest())
    expect(parsedGeneration).toMatchObject({
      code: ErrorCodes.invalidRequest,
      msg: '提示词引用的卡片不在当前画布或无法读取'
    })
  })
})

describe('R19 非引用误标纠正', () => {
  it('非引用 4401 保存不亮提示词卡，Toast 显示原始错误', async () => {
    const { logger } = loggerOf()
    const duplicateCard = arrangement()
    duplicateCard.cards = [
      ...duplicateCard.cards,
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'src-doc',
        title: '重复身份',
        summary: '',
        layout
      }
    ]
    startWorkbenchSession()
    useWorkbenchSessionStore.getState().setArrangement(duplicateCard, { baseline: arrangement() })
    commands = createWorkbenchCommands(canvasClient(canvasController(logger)))

    await commands.save('manual')

    expect(useWorkbenchSessionStore.getState().promptReferenceAlert).toBeNull()
    expect(useWorkbenchSessionStore.getState().saveError).toMatchObject({
      code: 4401,
      msg: '同一编排不能重复登记同一卡片'
    })
    expect(toast).toHaveBeenCalledWith('保存失败（同一编排不能重复登记同一卡片）')
  })

  it('非引用 4402 保存不亮提示词卡，Toast 显示原始错误', async () => {
    const { logger } = loggerOf()
    const missingRelation = arrangement()
    missingRelation.relations = [
      {
        relationId: 'rel-missing',
        fromCardId: 'doc',
        toCardId: 'missing-card',
        specificName: '',
        recordCardId: null
      }
    ]
    startWorkbenchSession()
    useWorkbenchSessionStore.getState().setArrangement(missingRelation, { baseline: arrangement() })
    commands = createWorkbenchCommands(canvasClient(canvasController(logger)))

    await commands.save('manual')

    expect(useWorkbenchSessionStore.getState().promptReferenceAlert).toBeNull()
    expect(useWorkbenchSessionStore.getState().saveError).toMatchObject({
      code: 4402,
      msg: '关联两端必须是当前编排中的卡片'
    })
    expect(toast).toHaveBeenCalledWith('保存失败（关联两端必须是当前编排中的卡片）')
  })
})
