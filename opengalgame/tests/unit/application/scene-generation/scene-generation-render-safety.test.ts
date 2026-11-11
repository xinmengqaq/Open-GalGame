import { expect, it } from 'vitest'

import {
  recentProgress,
  toHistorySummary,
  toRenderProgressEvent,
  toRenderStatusVO
} from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { toStatusVO } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import { phaseOf } from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import { parseSceneGenerationStatusResult } from '@interfaces/scene-generation/contracts/SceneGenerationResponseSchema'
import {
  retrySceneGenerationRepairSchema,
  startSceneGenerationSchema
} from '@interfaces/scene-generation/ipc/SceneGenerationRequestSchema'
import {
  generationPhaseOf,
  mergeRenderStatus,
  resumeRequestOf,
  resumeViewOf,
  type GenerationPhase
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'

import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type {
  ResumeSceneGenerationDTO,
  SceneGenerationInputsDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStage
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { SceneGenerationStateVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { SceneGenerationCandidatePreviewServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationCandidatePreviewServiceImpl'
import { SceneGenerationControlServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationControlServiceImpl'
import { SceneGenerationLaunchServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationLaunchServiceImpl'
import { SceneGenerationRenderQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationRenderQueryServiceImpl'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import {
  createSceneGenerationFixture,
  generationRequest,
  waitingInteraction,
  type SceneGenerationTestFixture
} from './sceneGenerationFixture'

const arrangement: SceneCanvasArrangementVO = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  canvasId: 'canvas-1',
  viewport: { x: 12, y: 34, zoom: 1.5 },
  cards: [],
  relations: []
}

it('保存失败或版本不一致时不创建执行、不调用模型', async () => {
  const failed = createSceneGenerationFixture()
  const launch = launchFor(
    failed,
    async () => {
      throw new AppException({
        code: SceneCanvasErrorCodes.commitFailed,
        msg: '编排已落盘，但还没进入作品修订'
      })
    },
    'saved-version'
  )
  await expect(launch.startSceneGeneration(startRequest())).rejects.toMatchObject({
    code: SceneCanvasErrorCodes.commitFailed
  })
  expect(failed.executions.size).toBe(0)
  expect(failed.workflow.executeGeneration).not.toHaveBeenCalled()
  expect(failed.artifacts.createWorkspace).not.toHaveBeenCalled()

  const mismatched = createSceneGenerationFixture()
  mismatched.input.readInputs.mockResolvedValue(await materialInputs('other-version'))
  const mismatchLaunch = launchFor(mismatched, async () => {}, 'saved-version')
  await expect(mismatchLaunch.startSceneGeneration(startRequest())).rejects.toMatchObject({
    code: SceneCanvasErrorCodes.commitUnknown
  })
  expect(mismatched.executions.size).toBe(0)
  expect(mismatched.workflow.executeGeneration).not.toHaveBeenCalled()
})

it('工作区未就绪时不保存画布、不启动模型，并保留 1309', async () => {
  const f = createSceneGenerationFixture()
  const order: string[] = []
  f.versions.ensureWorkspace.mockImplementation(async () => {
    order.push('ensure')
    throw new AppException({
      code: ProjectErrorCodes.workspaceNotReady,
      msg: 'D:/secret/.git 损坏'
    })
  })
  const launch = launchFor(
    f,
    async () => {
      order.push('save')
    },
    'saved-version'
  )
  await expect(launch.startSceneGeneration(startRequest())).rejects.toMatchObject({
    code: ProjectErrorCodes.workspaceNotReady,
    message: '工程初始化未完成，请重新构建'
  })
  expect(order).toEqual(['ensure'])
  expect(f.executions.size).toBe(0)
  expect(f.workflow.executeGeneration).not.toHaveBeenCalled()
})

it('工作区核对成功后才保存画布并启动', async () => {
  const f = createSceneGenerationFixture()
  const order: string[] = []
  f.input.readInputs.mockResolvedValue(await materialInputs('saved-version'))
  f.versions.ensureWorkspace.mockImplementation(async (projectId) => {
    order.push('ensure')
    return { projectId, sceneId: 'scene-1', canvasId: 'canvas-1' }
  })
  await launchFor(
    f,
    async () => {
      order.push('save')
    },
    'saved-version'
  ).startSceneGeneration(startRequest())
  expect(order[0]).toBe('ensure')
  expect(order[1]).toBe('save')
  expect(f.executions.size).toBe(1)
  expect(f.artifacts.createWorkspace).not.toHaveBeenCalled()
})

it('成功启动绑定素材正文和编排版本，并固定候选审阅', async () => {
  const f = createSceneGenerationFixture()
  f.input.readInputs.mockResolvedValue(await materialInputs('saved-version'))
  f.workflow.executeGeneration.mockResolvedValue({
    ...f.ready,
    budget: {
      ...f.ready.budget,
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      tokenLimit: 100
    }
  })
  const started = await launchFor(f, async () => {}, 'saved-version').startSceneGeneration(
    startRequest()
  )
  const execution = f.executions.get(started.operationId)!
  expect(execution.reviewCandidate).toBe(true)
  expect(execution.inputSnapshot.arrangementVersion).toBe('saved-version')
  expect(execution.inputSnapshot.documents[0]?.body).toContain('云还没有走')
  expect(execution.inputSnapshot.prompts[0]?.body).toContain('基础生成')
  expect(JSON.stringify(execution.inputSnapshot)).not.toContain('"x":12')
  expect(started.inputSummary).toMatchObject({
    arrangementVersion: 'saved-version',
    documentCount: 1,
    promptCount: 1
  })
  expect(started.inputSummary.details).toEqual({
    documents: ['角色与场景'],
    prompts: ['基础生成 · 场景']
  })
  expect(JSON.stringify(started)).not.toContain('projectRoot')

  const control = new SceneGenerationControlServiceImpl(f.deps, f.coordinator, f.generation)
  await control.pauseSceneGeneration({
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: started.operationId
  })
  await f.runNext()
  expect(f.versions.commitCandidate).not.toHaveBeenCalled()
  expect(f.executions.get(started.operationId)).toMatchObject({
    state: 'interrupted',
    interruptReason: 'paused',
    budget: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
  })

  const identity = f.executions.get(started.operationId)!
  await expect(
    f.service.resumeSceneGeneration({
      projectId: identity.projectId,
      sceneId: identity.sceneId,
      operationId: identity.operationId
    })
  ).rejects.toMatchObject({ code: 4103 })
  await expect(
    control.resumeSceneGeneration({
      projectId: identity.projectId,
      sceneId: identity.sceneId,
      operationId: identity.operationId,
      threadId: identity.threadId,
      branchId: identity.branchId,
      checkpointId: 'expired-checkpoint',
      candidateSnapshotId: identity.candidateSnapshotId
    })
  ).rejects.toMatchObject({ code: 4103 })

  f.workflow.resumeGeneration.mockResolvedValue({
    ...f.ready,
    budget: { correctionsUsed: 0, modelCallsUsed: 2, toolCallsUsed: 2, activeElapsedMs: 5 }
  })
  await control.resumeSceneGeneration({
    projectId: identity.projectId,
    sceneId: identity.sceneId,
    operationId: identity.operationId,
    threadId: identity.threadId,
    branchId: identity.branchId,
    checkpointId: identity.checkpointId!,
    candidateSnapshotId: identity.candidateSnapshotId
  })
  await f.runNext()
  expect(f.executions.get(started.operationId)?.budget).toMatchObject({
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    modelCallsUsed: 2
  })

  const render = new SceneGenerationRenderQueryServiceImpl(f.deps, f.coordinator)
  const status = await render.getSceneGenerationRenderStatus({
    projectId: identity.projectId,
    sceneId: identity.sceneId,
    operationId: identity.operationId
  })
  expect(status.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 })
  expect(JSON.stringify(status)).not.toContain('/project')
  const history = await f.service.listSceneGenerationHistoryForScene({
    projectId: 'project-1',
    sceneId: 'scene-1',
    limit: 10
  })
  expect(history[0]).toMatchObject({
    operationId: started.operationId,
    checkpointId: identity.checkpointId
  })
  expect(JSON.stringify(history)).not.toContain('projectRoot')
  expect(JSON.stringify(history)).not.toContain('云还没有走')

  const preview = new SceneGenerationCandidatePreviewServiceImpl(
    f.deps,
    renderDependencies(async () => {}, 'saved-version'),
    f.coordinator
  )
  await expect(
    preview.openSceneGenerationCandidatePreview({
      projectId: identity.projectId,
      sceneId: identity.sceneId,
      operationId: identity.operationId,
      threadId: identity.threadId,
      branchId: identity.branchId,
      checkpointId: identity.checkpointId!,
      candidateSnapshotId: 'unpublished'
    })
  ).rejects.toMatchObject({ code: 4103 })
})

it('已发布但缺少对白上下文的候选不能打开预览，齐备候选仍可授权', async () => {
  const f = createSceneGenerationFixture()
  f.input.readInputs.mockResolvedValue(await materialInputs('saved-version'))
  f.workflow.executeGeneration.mockResolvedValue(f.ready)
  const started = await launchFor(f, async () => {}, 'saved-version').startSceneGeneration(
    startRequest()
  )
  await f.runNext()
  const execution = f.executions.get(started.operationId)!
  execution.artifactValidation = {
    issues: [
      {
        code: 'missing-background',
        message: 'D:/secret/background.webp 缺失',
        correctable: true,
        requiresHumanDecision: false
      },
      {
        code: 'missing-character',
        message: '连续对白缺少已建立的角色，不能进入候选预览',
        correctable: true,
        requiresHumanDecision: false
      }
    ]
  }
  await f.workflow.writeExecution(execution)
  const preview = new SceneGenerationCandidatePreviewServiceImpl(
    f.deps,
    renderDependencies(async () => {}, 'saved-version'),
    f.coordinator
  )
  const request = {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!,
    candidateSnapshotId: execution.candidateSnapshotId!
  }
  await expect(preview.openSceneGenerationCandidatePreview(request)).rejects.toMatchObject({
    code: 4103
  })
  const status = await new SceneGenerationRenderQueryServiceImpl(
    f.deps,
    f.coordinator
  ).getSceneGenerationRenderStatus(request)
  expect(status.previewAvailable).toBe(false)
  expect(status.knownIssues?.map((issue) => issue.code)).toEqual([
    'missing-background',
    'missing-character'
  ])
  expect(JSON.stringify(status)).not.toContain('D:/secret')
  expect(status.knownIssues?.[0]?.message).toBe('连续对白缺少已建立的背景，不能进入候选预览')

  execution.artifactValidation = { issues: [] }
  await f.workflow.writeExecution(execution)
  const opened = Symbol('opened')
  const dependencies = renderDependencies(async () => {}, 'saved-version')
  dependencies.preview.openPublishedCandidatePreview = async () => ({
    preview: {
      previewSessionId: 'preview-1',
      candidateSnapshotId: request.candidateSnapshotId,
      url: 'http://127.0.0.1:9/',
      expiresAt: '2026-10-25T00:00:00.000Z'
    },
    stage: Promise.resolve()
  })
  await expect(
    new SceneGenerationCandidatePreviewServiceImpl(
      f.deps,
      dependencies,
      f.coordinator
    ).openSceneGenerationCandidatePreview(request)
  ).resolves.toMatchObject({ previewSessionId: 'preview-1' })
  expect(opened).toBeDefined()
})

it('素材增强诊断只透出安全引用事实，工程路径不进渲染状态', () => {
  const rendered = toRenderStatusVO(
    projectionExecution({
      artifactValidation: {
        issues: [
          {
            code: 'missing-asset',
            message: '候选引用的素材不存在',
            sequence: 4,
            correctable: true,
            requiresHumanDecision: false,
            reference: 'bg 云还没有走',
            line: 12,
            nearestReference: 'bg 教室',
            nearestAssetName: '教室',
            nearestAssetPath: 'D:/secret/assets/bg/教室.webp'
          }
        ]
      }
    })
  )
  expect(rendered.knownIssues).toEqual([
    {
      code: 'missing-asset',
      message: '候选引用的素材不存在',
      sequence: 4,
      correctable: true,
      requiresHumanDecision: false,
      reference: 'bg 云还没有走',
      line: 12,
      nearestReference: 'bg 教室',
      nearestAssetName: '教室'
    }
  ])
  const serialized = JSON.stringify(rendered)
  expect(serialized).not.toContain('nearestAssetPath')
  expect(serialized).not.toContain('D:/secret')
  expect(
    parseSceneGenerationStatusResult({
      code: ErrorCodes.success,
      msg: '生成状态已读取',
      data: rendered
    })?.data?.knownIssues
  ).toEqual(rendered.knownIssues)

  const legacy = toRenderStatusVO(
    projectionExecution({
      artifactValidation: {
        issues: [
          {
            code: 'missing-asset',
            message: '候选引用的素材不存在',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      }
    })
  )
  expect(legacy.knownIssues).toEqual([
    {
      code: 'missing-asset',
      message: '候选引用的素材不存在',
      correctable: true,
      requiresHumanDecision: false
    }
  ])
})

it('暂停后的渲染状态带当前检查点，旧检查点和错绑身份仍不能恢复', async () => {
  const f = createSceneGenerationFixture()
  f.input.readInputs.mockResolvedValue(await materialInputs('saved-version'))
  f.workflow.executeGeneration.mockResolvedValue(f.ready)
  const launch = launchFor(f, async () => {}, 'saved-version')
  const started = await launch.startSceneGeneration(startRequest())
  expect(started.checkpointId).toBeUndefined()
  expect(JSON.stringify(started)).not.toContain('projectRoot')
  expect(JSON.stringify(started)).not.toContain('/project')

  const control = new SceneGenerationControlServiceImpl(f.deps, f.coordinator, f.generation)
  await control.pauseSceneGeneration({
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: started.operationId
  })
  await f.runNext()
  const execution = f.executions.get(started.operationId)!
  const render = new SceneGenerationRenderQueryServiceImpl(f.deps, f.coordinator)
  const paused = await render.getSceneGenerationRenderStatus({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId
  })
  expect(paused.checkpointId).toBe(execution.checkpointId)
  expect(paused.checkpointId).toBeTruthy()
  expect(toRenderStatusVO({ ...execution, checkpointId: undefined }).checkpointId).toBeUndefined()
  const parsed = parseSceneGenerationStatusResult({
    code: 2000,
    msg: '生成状态已读取',
    data: paused
  })
  expect(parsed?.data?.checkpointId).toBe(execution.checkpointId)
  expect(JSON.stringify(parsed)).not.toContain('projectRoot')
  expect(JSON.stringify(parsed)).not.toContain('/secret')

  const scope = { projectId: paused.projectId, sceneId: paused.sceneId }
  expect(resumeRequestOf(paused, scope)).toEqual({
    projectId: paused.projectId,
    sceneId: paused.sceneId,
    operationId: paused.operationId,
    threadId: paused.threadId,
    branchId: paused.branchId,
    checkpointId: paused.checkpointId,
    ...(paused.candidateSnapshotId ? { candidateSnapshotId: paused.candidateSnapshotId } : {})
  })
  const identity = {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  }
  await expect(
    control.resumeSceneGeneration({ ...identity, checkpointId: 'old-checkpoint' })
  ).rejects.toMatchObject({ code: 4103 })
  await expect(
    control.resumeSceneGeneration({ ...identity, threadId: 'other-thread' })
  ).rejects.toMatchObject({ code: 4103 })
  await expect(
    control.resumeSceneGeneration({ ...identity, branchId: 'other-branch' })
  ).rejects.toMatchObject({ code: 4103 })
  await expect(
    control.resumeSceneGeneration({
      ...identity,
      candidateSnapshotId: execution.candidateSnapshotId ? 'other-snapshot' : 'unexpected-snapshot'
    })
  ).rejects.toMatchObject({ code: 4103 })
  if (execution.candidateSnapshotId) {
    await expect(control.resumeSceneGeneration(identity)).rejects.toMatchObject({ code: 4103 })
  }

  f.workflow.resumeGeneration.mockResolvedValue({
    ...f.ready,
    budget: { correctionsUsed: 0, modelCallsUsed: 2, toolCallsUsed: 2, activeElapsedMs: 5 }
  })
  const request = resumeRequestOf(parsed?.data ?? null, scope)
  expect(request?.checkpointId).toBe(execution.checkpointId)
  await control.resumeSceneGeneration(request!)
  await f.runNext()
  expect(f.workflow.resumeGeneration).toHaveBeenCalledTimes(1)
})

it('安全暂停后只采纳进度事件时，可继续的检查点显示继续并绑定当前身份', async () => {
  const observed = await observePausedProgress(true)
  expect(observed.report.phase).toBe('paused')
  expect(observed.report.button).toBe('继续生成')
  expect(observed.report.canResume).toBe(true)
  expect(observed.report.eventCanResume).toBe(true)
  expect(observed.report.otherEventsResumable).toBe(false)
  expect(observed.report.request).toEqual(observed.expectedRequest)
  expect(observed.eventText).not.toContain('projectRoot')
  expect(observed.eventText).not.toContain('filePath')
  expect(observed.eventText).not.toContain('entryFile')
  await expect(
    observed.control.resumeSceneGeneration({
      ...observed.expectedRequest,
      checkpointId: 'old-checkpoint'
    })
  ).rejects.toMatchObject({ code: 4103 })
  observed.fixture.workflow.resumeGeneration.mockResolvedValue({
    ...observed.fixture.ready,
    budget: { correctionsUsed: 0, modelCallsUsed: 2, toolCallsUsed: 2, activeElapsedMs: 5 }
  })
  await observed.control.resumeSceneGeneration(observed.expectedRequest)
  await observed.fixture.runNext()
  expect(observed.fixture.workflow.resumeGeneration).toHaveBeenCalledTimes(1)
})

it('检查点不能继续时，只采纳暂停进度事件仍不显示继续', async () => {
  const observed = await observePausedProgress(false)
  expect(observed.report.phase).toBe('paused')
  expect(observed.report.button).toBeNull()
  expect(observed.report.canResume).toBe(false)
  expect(observed.report.eventCanResume).toBe(false)
  expect(observed.report.reason).toBe('当前检查点不能继续，本次生成不可续跑。')
  expect(observed.report.request).toBeNull()
})

it('暂停事件读取检查点失败时保留已暂停记录，非暂停写入不读取检查点', async () => {
  const observed = await observePausedProgress(true, true)
  const execution = observed.fixture.executions.get(observed.expectedRequest.operationId)
  expect(execution?.state).toBe('interrupted')
  expect(execution?.interruptReason).toBe('paused')
  expect(execution?.workspace).toBeTruthy()
  expect(observed.fixture.artifacts.discardWorkspace).not.toHaveBeenCalled()
  expect(observed.report.eventCanResume).toBeNull()
  expect(observed.report.pauseCanResume).toBe(false)
  await expect(
    new SceneGenerationRenderQueryServiceImpl(
      observed.fixture.deps,
      observed.fixture.coordinator
    ).getSceneGenerationRenderStatus(observed.expectedRequest)
  ).rejects.toMatchObject({ code: 4103 })
  const reads = observed.fixture.workflow.readCheckpoint.mock.calls.length
  observed.fixture.workflow.readCheckpoint.mockResolvedValue({
    execution: execution!,
    candidateSnapshotId: execution?.candidateSnapshotId,
    view: {
      projectId: execution!.projectId,
      sceneId: execution!.sceneId,
      operationId: execution!.operationId,
      threadId: execution!.threadId,
      branchId: execution!.branchId,
      checkpointId: execution!.checkpointId!,
      phase: phaseOf(execution!.state, execution!.step),
      summary: '已恢复',
      decisions: [],
      differences: [],
      canView: true,
      canContinue: true
    }
  })
  await observed.fixture.coordinator.writeExecution({
    ...execution!,
    state: 'running',
    interruptReason: undefined,
    sequence: execution!.sequence + 1
  })
  expect(observed.fixture.workflow.readCheckpoint).toHaveBeenCalledTimes(reads)
})

function startRequest(): StartSceneGenerationDTO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    confirmedControls: [],
    policy: generationRequest.policy
  }
}

function launchFor(
  fixture: SceneGenerationTestFixture,
  saveArrangement: SceneGenerationRenderDependencies['saveArrangement'],
  arrangementVersion: string
): SceneGenerationLaunchServiceImpl {
  return new SceneGenerationLaunchServiceImpl(
    fixture.deps,
    renderDependencies(saveArrangement, arrangementVersion),
    fixture.generation,
    fixture.coordinator
  )
}

function renderDependencies(
  saveArrangement: SceneGenerationRenderDependencies['saveArrangement'],
  arrangementVersion: string
): SceneGenerationRenderDependencies {
  return {
    canvasVersions: {
      keepArrangement: async () => ({ state: 'kept' }),
      readSettlement: async () => ({ state: 'kept' }),
      readArrangementVersion: async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        arrangementVersion
      })
    },
    saveArrangement,
    readCurrentArrangement: async () => arrangement,
    production: {
      resolveRegisteredScene: async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        projectRoot: '/project',
        sceneDirectory: 'scenes/scene-1',
        entryFile: 'start.txt'
      })
    },
    preview: {
      openPublishedCandidatePreview: async () => {
        throw new Error('预览物化不属于本测试')
      },
      closeCandidatePreview: async () => {},
      invalidateCandidatePreviewSessions: async () => {},
      subscribeCandidatePreviewEvents: () => () => undefined,
      readCandidatePreviewEvent: () => undefined
    }
  }
}

async function materialInputs(arrangementVersion: string): Promise<SceneGenerationInputsDTO> {
  const documentBody = [
    '# 角色与场景',
    '',
    '傍晚的旧车站，云还没有走，站台广播压低了雨声。',
    '林晚把伞收在身侧，没有先开口。',
    '周野：你还是习惯站在灯下面。'
  ].join('\n')
  const promptBody = [
    '# 基础生成',
    '',
    '按已保存编排生成这一场，保持克制，不提前揭示身份。',
    '对白简短，保留一次环境音提示。'
  ].join('\n')
  return {
    canvasId: 'canvas-1',
    arrangementVersion,
    assets: [],
    documents: [
      {
        id: 'document-1',
        sourceId: 'canvas-document-1',
        title: '角色与场景',
        summary: '',
        body: documentBody,
        topics: ['角色'],
        usage: { targetIds: [] }
      }
    ],
    prompts: [
      {
        id: 'prompt-1',
        title: '基础生成',
        body: promptBody,
        scopes: [{ kind: 'scene' as const }],
        references: [],
        usage: { targetIds: [] }
      }
    ],
    fieldBindings: [],
    relations: [],
    confirmedControls: []
  }
}

type PausedProgressObservation = {
  fixture: SceneGenerationTestFixture
  control: SceneGenerationControlServiceImpl
  expectedRequest: ResumeSceneGenerationDTO
  eventText: string
  report: {
    phase: GenerationPhase
    button: '继续生成' | null
    reason: string | null
    canResume: boolean
    state: SceneGenerationStateVO
    stage: SceneGenerationRenderStage
    checkpointId: string | undefined
    candidateSnapshotId: string | undefined
    sequence: number
    pauseCanResume: boolean
    pauseStage: SceneGenerationRenderStage
    eventCanResume: boolean | null
    otherEventsResumable: boolean
    request: ResumeSceneGenerationDTO | null
  }
}

/** 启动可控工作流并安全暂停；按钮只根据进度事件采纳结果，不重新查询状态。 */
async function observePausedProgress(
  canContinue: boolean,
  checkpointReadFails = false
): Promise<PausedProgressObservation> {
  const fixture = createSceneGenerationFixture()
  if (checkpointReadFails) {
    fixture.workflow.readCheckpoint.mockRejectedValue(
      new AppException({ code: ErrorCodes.operationConflict, msg: '历史检查点不存在' })
    )
  } else if (!canContinue) {
    const original = fixture.workflow.readCheckpoint.getMockImplementation()
    if (!original) throw new Error('检查点替身缺失')
    fixture.workflow.readCheckpoint.mockImplementation(async (request) => {
      const checkpoint = await original(request)
      return { ...checkpoint, view: { ...checkpoint.view, canContinue: false } }
    })
  }
  fixture.input.readInputs.mockResolvedValue(await materialInputs('saved-version'))
  fixture.workflow.executeGeneration.mockResolvedValue(fixture.ready)
  const started = await launchFor(fixture, async () => {}, 'saved-version').startSceneGeneration(
    startRequest()
  )
  const render = new SceneGenerationRenderQueryServiceImpl(fixture.deps, fixture.coordinator)
  const control = new SceneGenerationControlServiceImpl(
    fixture.deps,
    fixture.coordinator,
    fixture.generation
  )
  const scope = {
    projectId: started.projectId,
    sceneId: started.sceneId,
    operationId: started.operationId
  }
  const events: SceneGenerationRenderProgressEventVO[] = []
  let adopted = started
  const stop = render.subscribeSceneGenerationProgress(scope, (event) => {
    events.push(event)
    adopted = mergeRenderStatus(adopted, event)
  })
  try {
    const pauseResponse = await control.pauseSceneGeneration(scope)
    adopted = mergeRenderStatus(adopted, pauseResponse)
    await fixture.runNext()
    const execution = fixture.executions.get(started.operationId)
    if (!execution?.checkpointId) throw new Error('安全暂停没有留下检查点')
    const pausedEvent = events.filter((event) => event.stage === 'paused').at(-1)
    const view = resumeViewOf(adopted)
    const phase = generationPhaseOf(adopted)
    const request = view.canResume
      ? resumeRequestOf(adopted, { projectId: adopted.projectId, sceneId: adopted.sceneId })
      : null
    return {
      fixture,
      control,
      expectedRequest: {
        projectId: execution.projectId,
        sceneId: execution.sceneId,
        operationId: execution.operationId,
        threadId: execution.threadId,
        branchId: execution.branchId,
        checkpointId: execution.checkpointId,
        ...(execution.candidateSnapshotId
          ? { candidateSnapshotId: execution.candidateSnapshotId }
          : {})
      },
      eventText: JSON.stringify(pausedEvent ?? null),
      report: {
        phase,
        button: phase === 'paused' && view.canResume ? ('继续生成' as const) : null,
        reason: view.reason,
        canResume: adopted.canResume,
        state: adopted.state,
        stage: adopted.stage,
        checkpointId: adopted.checkpointId,
        candidateSnapshotId: adopted.candidateSnapshotId,
        sequence: adopted.sequence,
        pauseCanResume: pauseResponse.canResume,
        pauseStage: pauseResponse.stage,
        eventCanResume: pausedEvent?.canResume ?? null,
        otherEventsResumable: events.some((event) => event.stage !== 'paused' && event.canResume),
        request
      }
    }
  } finally {
    stop()
  }
}

it('失败按原因使用固定安全文案，旧记录映射或回退安全消息，未知原文回退阶段文案', () => {
  const failed = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'D:/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'failed' as const,
    step: undefined,
    attempt: 1,
    sequence: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    failure: { code: ErrorCodes.operationConflict, message: '模型连接中断，本次生成未完成。' }
  }
  expect(toRenderStatusVO(failed).failure).toEqual({
    code: ErrorCodes.operationConflict,
    message: '模型连接中断，本次生成未完成。',
    unverified: false,
    legacy: true
  })
  expect(toRenderStatusVO(failed).updatedAt).toBeUndefined()
  expect(toRenderStatusVO({ ...failed, updatedAt: '2026-10-31T12:34:56.789Z' }).updatedAt).toBe(
    '2026-10-31T12:34:56.789Z'
  )
  expect(
    toRenderStatusVO({
      ...failed,
      failure: { ...failed.failure, message: '' }
    }).failure?.message
  ).toBe('本次生成未完成')
  expect(
    toRenderStatusVO({
      ...failed,
      failure: {
        code: ErrorCodes.operationConflict,
        message: '连续读取没有获得新内容，本次生成已停止',
        diagnosticRef: 'a1b2c3d4e5f6',
        candidateSnapshotId: 'candidate-1'
      }
    }).failure
  ).toEqual({
    code: ErrorCodes.operationConflict,
    message: '重复读取没有获得新内容，本次生成已停止',
    reference: 'a1b2c3d4e5f6',
    unverified: false,
    candidateSnapshotId: 'candidate-1',
    legacy: true
  })
  expect(
    toRenderStatusVO({
      ...failed,
      failure: {
        ...failed.failure,
        message: '重复读取没有获得新内容，本次生成已停止'
      }
    }).failure?.message
  ).toBe('重复读取没有获得新内容，本次生成已停止')
  const sensitiveFailure = toRenderStatusVO({
    ...failed,
    failure: {
      ...failed.failure,
      message: '读取 D:/project/secret.txt 失败：Authorization: Bearer sk-live-1234567890'
    }
  }).failure
  expect(sensitiveFailure?.message).toBe('本次生成未完成')
  expect(JSON.stringify(sensitiveFailure)).not.toContain('secret.txt')
  expect(JSON.stringify(sensitiveFailure)).not.toContain('sk-live')
  expect(
    toRenderStatusVO({
      ...failed,
      failure: {
        ...failed.failure,
        message: '连续读取没有获得新内容，本次生成已停止。底层路径 D:/project/secret.txt'
      }
    }).failure?.message
  ).toBe('本次生成未完成')

  const expectedMessages = {
    noInformationGain: '重复读取没有获得新内容，本次生成已停止',
    missingCandidateWrite: '收到完成提示后仍未写出候选，本次生成已停止',
    outputTruncated: '模型输出达到长度上限，本次生成未完成',
    missingStructuredResult: '模型没有提交结构化结果，本次生成未完成',
    structuredOutput: '模型输出不符合约定，本次生成未完成',
    modelFailure: '模型调用失败，本次生成未完成',
    modelRejected: '模型拒绝了本次请求，请核对连接设置',
    modelAccess: '模型鉴权失败，请检查连接设置',
    contextOverflow: '输入超出模型可处理范围，本次生成未完成',
    correctionsExhausted: '自动修正次数已用尽，请审阅候选后手动修改'
  } as const
  const expectedFailureFacts = {
    noInformationGain: ['noProgress', ['retryRepair', 'viewCandidate', 'regenerate']],
    missingCandidateWrite: ['outputContract', ['viewCandidate', 'retryOperation', 'regenerate']],
    outputTruncated: ['outputContract', ['viewCandidate', 'retryOperation', 'regenerate']],
    missingStructuredResult: ['outputContract', ['viewCandidate', 'retryOperation', 'regenerate']],
    structuredOutput: ['outputContract', ['viewCandidate', 'retryOperation', 'regenerate']],
    modelFailure: ['modelTransient', ['retryOperation', 'viewCandidate']],
    modelRejected: ['modelRejected', ['reviseRequirement', 'viewInputSummary']],
    modelAccess: ['modelAuth', ['checkConnection', 'viewInputSummary']],
    contextOverflow: ['contextOverflow', ['reduceInput', 'viewInputSummary']],
    correctionsExhausted: ['correctionsExhausted', ['reviseRequirement', 'discard']]
  } as const
  for (const [reason, message] of Object.entries(expectedMessages)) {
    const [failureClass, nextActions] =
      expectedFailureFacts[reason as keyof typeof expectedMessages]
    const failure = toRenderStatusVO({
      ...failed,
      failure: {
        ...failed.failure,
        reason: reason as keyof typeof expectedMessages,
        diagnosticRef: 'a1b2c3d4e5f6'
      }
    }).failure
    expect(failure).toEqual({
      code: ErrorCodes.operationConflict,
      message,
      reason,
      failureClass,
      nextActions,
      reference: 'a1b2c3d4e5f6',
      unverified: false,
      // 该用例的执行记录只有原因，没有持久化分类和动作，按旧记录近似标记。
      legacy: true
    })
    expect(failure).not.toHaveProperty('category')
    expect(failure).not.toHaveProperty('httpStatus')
    expect(failure).not.toHaveProperty('causeName')
  }
})

it('只有 commitUnknown 标记待核对，5102 本身不改变核对状态', () => {
  const failed = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'D:/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'failed' as const,
    step: undefined,
    attempt: 1,
    sequence: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    failure: {
      code: ErrorCodes.operationConflict,
      message: '原始异常不应出现',
      reason: 'modelFailure' as const,
      diagnosticRef: 'c0a17b93e52d'
    }
  }
  expect(
    toRenderStatusVO({
      ...failed,
      state: 'interrupted',
      interruptReason: 'commitUnknown'
    }).failure
  ).toEqual({
    code: ErrorCodes.operationConflict,
    message: '提交结果待核对',
    reason: 'modelFailure',
    failureClass: 'modelTransient',
    nextActions: ['retryOperation', 'viewCandidate'],
    reference: 'c0a17b93e52d',
    unverified: true
  })
  expect(
    toRenderStatusVO({
      ...failed,
      state: 'interrupted',
      interruptReason: 'candidateConflict'
    }).failure
  ).toEqual({
    code: ErrorCodes.operationConflict,
    message: '候选或基线冲突，需要重新核对',
    reason: 'modelFailure',
    failureClass: 'modelTransient',
    nextActions: ['retryOperation', 'viewCandidate'],
    reference: 'c0a17b93e52d',
    unverified: false
  })
  expect(
    toRenderStatusVO({
      ...failed,
      failure: { code: ErrorCodes.communicationFailed, message: '提交结果待核对' }
    }).failure
  ).toEqual({
    code: ErrorCodes.communicationFailed,
    message: '提交结果待核对',
    unverified: false,
    legacy: true
  })
  expect(toRenderStatusVO({ ...failed, failure: undefined }).failure).toBeUndefined()
})

it('旧记录没有 live 时仍可渲染，进行中记录投影活动', () => {
  const running = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'D:/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'running' as const,
    step: 'generating' as const,
    attempt: 1,
    sequence: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 2, toolCallsUsed: 3, activeElapsedMs: 0 },
    replies: []
  }
  const legacy = toRenderStatusVO(running)
  expect(legacy.activity).toBeUndefined()
  expect(legacy.usage.modelCalls).toBe(2)
  expect(legacy.usage.toolCalls).toBe(3)
  const live = toRenderStatusVO({
    ...running,
    live: {
      activity: 'tool',
      lastActivityAt: '2026-10-29T00:00:00.000Z',
      lastToolName: 'readTextRange',
      noNewInformationStreak: 1
    }
  })
  expect(live.activity).toEqual({
    kind: 'tool',
    lastActivityAt: '2026-10-29T00:00:00.000Z',
    lastToolName: 'readTextRange',
    noNewInformationStreak: 1
  })
  const unknownTool = toRenderStatusVO({
    ...running,
    live: {
      activity: 'tool',
      lastActivityAt: '2026-10-29T00:00:00.000Z',
      lastToolName: 'read_file',
      noNewInformationStreak: 1
    }
  })
  expect(unknownTool.activity).toEqual({
    kind: 'tool',
    lastActivityAt: '2026-10-29T00:00:00.000Z',
    noNewInformationStreak: 1
  })
  expect(
    toRenderStatusVO({
      ...running,
      state: 'failed',
      step: undefined,
      live: { activity: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
    }).activity
  ).toBeUndefined()
})

it('修复重试请求只带身份和确认正文，路径与检查点内部不能进入请求', () => {
  const repair = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    confirmedControls: [],
    policy: { maxCorrections: 1 },
    repair: {
      sourceOperationId: 'source-operation',
      sourceThreadId: 'source-thread',
      sourceBranchId: 'source-branch',
      sourceCheckpointId: 'source-checkpoint',
      candidateSnapshotId: 'previous-candidate',
      instruction: '把结尾音乐改成停止，不要把标题当台词。'
    }
  }
  expect(retrySceneGenerationRepairSchema.safeParse(repair).success).toBe(true)
  expect(
    retrySceneGenerationRepairSchema.safeParse({
      ...repair,
      repair: { ...repair.repair, sourcePath: 'D:/secret/start.txt' }
    }).success
  ).toBe(false)
  expect(
    retrySceneGenerationRepairSchema.safeParse({
      ...repair,
      repair: { ...repair.repair, checkpoint: { channel_values: 'raw' } }
    }).success
  ).toBe(false)
  expect(startSceneGenerationSchema.safeParse(repair).success).toBe(false)
})

it('失败候选投影只读授权、修复正文和来源身份，不带路径或模型原文', () => {
  const failed = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'D:/secret/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: true,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'failed' as const,
    step: undefined,
    attempt: 1,
    sequence: 2,
    budget: { correctionsUsed: 0, modelCallsUsed: 1, toolCallsUsed: 0, activeElapsedMs: 0 },
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'candidate-1',
    artifactValidation: { issues: [] },
    mode: 'repair' as const,
    repairSource: {
      operationId: 'source-operation',
      threadId: 'source-thread',
      branchId: 'source-branch',
      checkpointId: 'source-checkpoint',
      candidateSnapshotId: 'previous-candidate'
    },
    replies: [
      {
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-1',
        threadId: 'thread-1',
        branchId: 'branch-1',
        interactionId: 'interaction-1',
        checkpointId: 'checkpoint-1',
        replyId: 'reply-1',
        reply: { kind: 'revise' as const, body: '把结尾音乐改成停止。' }
      }
    ],
    failure: {
      code: ErrorCodes.operationConflict,
      message: '模型原文不应出现',
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly' as const
    }
  }
  const rendered = toRenderStatusVO(failed)
  expect(rendered.previewAvailable).toBe(true)
  expect(rendered.previewAuthorization).toBe('readOnly')
  expect(rendered.mode).toBe('repair')
  expect(rendered.repairSource).toEqual(failed.repairSource)
  expect(rendered.userMessages).toEqual([
    { kind: 'revise', body: '把结尾音乐改成停止。', round: 1 }
  ])
  expect(rendered.failure?.candidateSnapshotId).toBe('candidate-1')
  expect(rendered.failure?.previewAuthorization).toBe('readOnly')
  expect(rendered.interaction).toBeUndefined()
  const serialized = JSON.stringify(rendered)
  expect(serialized).not.toContain('D:/secret')
  expect(serialized).not.toContain('projectRoot')
  expect(serialized).not.toContain('模型原文')
  expect(
    parseSceneGenerationStatusResult({
      code: ErrorCodes.success,
      msg: '生成状态已读取',
      data: rendered
    })?.data
  ).toMatchObject({
    previewAuthorization: 'readOnly',
    mode: 'repair',
    userMessages: [{ kind: 'revise', body: '把结尾音乐改成停止。' }]
  })
})

it('待核对中断可按只读授权查看已有候选，暂停不授予只读候选入口', () => {
  const facts = {
    state: 'interrupted' as const,
    interruptReason: 'commitUnknown' as const,
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'candidate-1',
    artifactValidation: { issues: [] },
    failure: {
      code: ErrorCodes.operationConflict,
      message: '提交结果待核对',
      reason: 'modelFailure' as const,
      failureClass: 'modelTransient' as const,
      nextActions: ['retryOperation', 'viewCandidate'] as const,
      diagnosticRef: '0123456789ab',
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly' as const
    }
  }
  const rendered = toRenderStatusVO(projectionExecution(facts))
  expect(rendered.previewAuthorization).toBe('readOnly')
  expect(rendered.failure).toMatchObject({
    message: '提交结果待核对',
    failureClass: 'modelTransient',
    unverified: true
  })
  expect(rendered.failure?.nextActions).toEqual(['retryOperation', 'viewCandidate'])
  expect(rendered.failure?.legacy).toBeUndefined()

  const paused = toRenderStatusVO(
    projectionExecution({ ...facts, interruptReason: 'paused', failure: undefined })
  )
  expect(paused.previewAuthorization).toBeUndefined()
  expect(paused.failure).toBeUndefined()
})

it('最近进度只取执行时间线最后 6 条安全文案，旧记录保持缺失', () => {
  const timeline = Array.from({ length: 8 }, (_, index) => ({
    entryId: `entry-${index}`,
    sequence: index,
    createdAt: new Date(Date.UTC(2026, 10, 4, 12, 0, index)).toISOString(),
    kind: 'stage' as const,
    stage: 'generating' as const,
    message: 'AI 正在生成候选脚本'
  }))
  const rendered = toRenderStatusVO(
    projectionExecution({ state: 'running', step: 'generating', timeline })
  )
  expect(rendered.recentProgress).toHaveLength(6)
  expect(rendered.recentProgress?.map((entry) => entry.sequence)).toEqual([2, 3, 4, 5, 6, 7])
  expect(rendered.recentProgress?.[0]).toEqual({
    sequence: 2,
    createdAt: new Date(Date.UTC(2026, 10, 4, 12, 0, 2)).toISOString(),
    stage: 'generating',
    message: 'AI 正在生成候选脚本'
  })
  expect(JSON.stringify(rendered)).not.toContain('projectRoot')
  expect(JSON.stringify(rendered)).not.toContain('/project')
  const unsafe = toRenderStatusVO(
    projectionExecution({
      timeline: [
        {
          entryId: 'entry-raw',
          sequence: 1,
          createdAt: '2026-11-04T12:00:00.000Z',
          kind: 'stage',
          stage: 'generating',
          message: '模型原文 D:/secret/start.txt'
        },
        {
          entryId: 'entry-time',
          sequence: 2,
          createdAt: 'D:/secret/time',
          kind: 'stage',
          stage: 'generating',
          message: 'AI 正在生成候选脚本'
        },
        ...timeline
      ]
    })
  )
  expect(unsafe.recentProgress).toHaveLength(6)
  expect(JSON.stringify(unsafe)).not.toContain('D:/secret')
  expect(JSON.stringify(unsafe)).not.toContain('模型原文')
  expect(recentProgress(projectionExecution())).toBeUndefined()
})

it('历史摘要补安全失败原因和旧记录标记，旧记录不补造原因', () => {
  const createdAt = '2026-11-04T12:00:00.000Z'
  const failed = projectionExecution({
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'candidate-1',
    updatedAt: createdAt,
    failure: {
      code: ErrorCodes.operationConflict,
      message: '模型调用失败',
      reason: 'modelFailure',
      failureClass: 'modelTransient',
      nextActions: ['retryOperation', 'viewCandidate'],
      diagnosticRef: '0123456789ab'
    }
  })
  expect(toHistorySummary(failed, createdAt)).toMatchObject({
    boundary: 'failed',
    stage: 'failed',
    failureReason: 'modelFailure'
  })
  expect(toHistorySummary(failed, createdAt)?.legacy).toBeUndefined()

  const legacySummary = toHistorySummary(
    projectionExecution({
      checkpointId: 'checkpoint-1',
      failure: { code: ErrorCodes.operationConflict, message: '模型连接中断，本次生成未完成。' }
    }),
    createdAt
  )
  expect(legacySummary).toMatchObject({ boundary: 'failed', legacy: true })
  expect(legacySummary && 'failureReason' in legacySummary).toBe(false)
  expect(JSON.stringify(legacySummary)).not.toContain('projectRoot')
})

it('执行记录的安全分类和动作优先于原因映射', () => {
  const rendered = toRenderStatusVO(
    projectionExecution({
      failure: {
        code: ErrorCodes.operationConflict,
        message: '输入不满足生成条件',
        reason: 'modelFailure',
        failureClass: 'inputInvalid',
        nextActions: ['returnToCanvas', 'viewInputSummary'],
        diagnosticRef: '0123456789ab'
      }
    })
  )
  expect(rendered.failure).toMatchObject({
    reason: 'modelFailure',
    failureClass: 'inputInvalid',
    nextActions: ['returnToCanvas', 'viewInputSummary'],
    reference: '0123456789ab'
  })
  expect(rendered.failure?.legacy).toBeUndefined()
})

it('有安全分类但缺下一步动作的失败标旧记录并按分类补足动作', () => {
  const execution = projectionExecution({
    checkpointId: 'checkpoint-1',
    failure: {
      code: ErrorCodes.operationConflict,
      message: '模型没有提交结构化结果，本次生成未完成',
      reason: 'missingStructuredResult',
      failureClass: 'outputContract'
    }
  })
  expect(toRenderStatusVO(execution).failure).toMatchObject({
    failureClass: 'outputContract',
    nextActions: ['viewCandidate', 'retryOperation', 'regenerate'],
    legacy: true
  })
  expect(toHistorySummary(execution, '2026-11-04T12:00:00.000Z')).toMatchObject({
    boundary: 'failed',
    failureReason: 'missingStructuredResult',
    legacy: true
  })
})

it('待核对或候选冲突中断不补历史失败原因和旧记录标记', () => {
  const createdAt = '2026-11-04T12:00:00.000Z'
  for (const interruptReason of ['commitUnknown', 'candidateConflict'] as const) {
    const execution = projectionExecution({
      state: 'interrupted',
      step: undefined,
      interruptReason,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'candidate-1',
      failure: {
        code: ErrorCodes.operationConflict,
        message: '底层失败原文',
        reason: 'modelFailure',
        failureClass: 'modelTransient',
        nextActions: ['retryOperation', 'viewCandidate'],
        diagnosticRef: '0123456789ab'
      }
    })
    const summary = toHistorySummary(execution, createdAt)
    expect(summary).toMatchObject({ boundary: 'failed', stage: 'failed' })
    expect(summary && 'failureReason' in summary).toBe(false)
    expect(summary?.legacy).toBeUndefined()
  }
})

it('渲染失败只公开安全分类和动作，诊断分类、状态和原因名不进入状态', () => {
  const rendered = toRenderStatusVO(
    projectionExecution({
      failure: {
        code: ErrorCodes.operationConflict,
        message: '模型调用失败，本次生成未完成',
        reason: 'modelFailure',
        failureClass: 'modelTransient',
        nextActions: ['retryOperation', 'viewCandidate'],
        category: 'sdk',
        httpStatus: 500,
        causeName: 'APIError',
        diagnosticRef: '0123456789ab'
      }
    })
  )
  expect(rendered.failure).toMatchObject({
    reason: 'modelFailure',
    failureClass: 'modelTransient',
    nextActions: ['retryOperation', 'viewCandidate'],
    reference: '0123456789ab'
  })
  const serialized = JSON.stringify(rendered)
  expect(serialized).not.toContain('"category"')
  expect(serialized).not.toContain('"httpStatus"')
  expect(serialized).not.toContain('"causeName"')
  expect(serialized).not.toContain('APIError')
})

it('running 态不再输出上一轮审阅交互，waiting 态保留交互', () => {
  expect(
    toRenderStatusVO(projectionExecution({ state: 'running', interaction: waitingInteraction }))
      .interaction
  ).toBeUndefined()
  expect(
    toRenderProgressEvent(
      projectionExecution({ state: 'running', interaction: waitingInteraction })
    ).interaction
  ).toBeUndefined()

  const waiting = toRenderStatusVO(
    projectionExecution({ state: 'waiting', interaction: waitingInteraction })
  )
  expect(waiting.interaction).toMatchObject({
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    kind: 'review',
    message: '是否接受这个候选？',
    allowedReplies: ['accept', 'revise', 'discard']
  })
})

it('状态查询在 running 时不透出上一轮人工交互，waiting 仍可查询到', () => {
  expect(
    toStatusVO(projectionExecution({ state: 'running', interaction: waitingInteraction }), true)
      .interaction
  ).toBeUndefined()
  expect(
    toStatusVO(projectionExecution({ state: 'waiting', interaction: waitingInteraction }), false)
      .interaction
  ).toMatchObject({ interactionId: 'interaction-1', kind: 'review' })
})

it('输入摘要附带文档、提示词和关系明细，不泄露正文与路径', () => {
  const rendered = toRenderStatusVO(
    projectionExecution({ inputSnapshot: detailInputs() })
  )
  expect(rendered.inputSummary.details).toEqual({
    documents: ['角色与场景', '世界观'],
    prompts: ['基础生成 · 场景', '卡片提示 · 卡片×2、关系×1'],
    relations: [
      '林晚与场景（记录：文档）',
      '角色与场景（记录：文档）',
      '记录：提示词',
      '未命名关系'
    ]
  })
  const serialized = JSON.stringify(rendered.inputSummary)
  expect(serialized).not.toContain('正文')
  expect(serialized).not.toContain('D:/secret')
})

it('输入摘要明细最多 12 条，超出显示等 N 项', () => {
  const documents = Array.from({ length: 15 }, (_, index) => ({
    id: `document-${index + 1}`,
    sourceId: `canvas-document-${index + 1}`,
    title: `文档 ${index + 1}`,
    summary: '',
    body: '',
    topics: [],
    usage: { targetIds: [] }
  }))
  const overflow = toRenderStatusVO(
    projectionExecution({
      inputSnapshot: { ...emptyInputs(), documents }
    })
  ).inputSummary.details
  expect(overflow?.documents).toHaveLength(12)
  expect(overflow?.documents?.[0]).toBe('文档 1')
  expect(overflow?.documents?.[11]).toBe('等 4 项')

  const exact = toRenderStatusVO(
    projectionExecution({
      inputSnapshot: { ...emptyInputs(), documents: documents.slice(0, 12) }
    })
  ).inputSummary.details
  expect(exact?.documents).toHaveLength(12)
  expect(exact?.documents?.[11]).toBe('文档 12')
})

it('没有快照明细时不输出 details', () => {
  expect(toRenderStatusVO(projectionExecution()).inputSummary.details).toBeUndefined()
})

it('提示词没有标题时回退为未命名提示词，重复名称编号且不展示正文', () => {
  const prompt = (
    id: string,
    title: string
  ): SceneGenerationInputsDTO['prompts'][number] => ({
    id,
    title,
    body: '提示词正文不应进入输入摘要',
    scopes: [{ kind: 'scene' }],
    references: [],
    usage: { targetIds: [] }
  })
  const rendered = toRenderStatusVO(
    projectionExecution({
      inputSnapshot: {
        ...emptyInputs(),
        prompts: [prompt('prompt-uuid-1', 'prompt-uuid-1'), prompt('prompt-uuid-2', '   ')]
      }
    })
  )
  expect(rendered.inputSummary.details?.prompts).toEqual([
    '未命名提示词 1 · 场景',
    '未命名提示词 2 · 场景'
  ])
  const serialized = JSON.stringify(rendered.inputSummary)
  expect(serialized).not.toContain('prompt-uuid')
  expect(serialized).not.toContain('正文')

  const single = toRenderStatusVO(
    projectionExecution({
      inputSnapshot: { ...emptyInputs(), prompts: [prompt('prompt-uuid-3', 'prompt-uuid-3')] }
    })
  )
  expect(single.inputSummary.details?.prompts).toEqual(['未命名提示词 · 场景'])
})

it('同名关系按数据顺序编号并保留记录说明，唯一名称不编号', () => {
  const relation = (
    relationId: string,
    specificName: string,
    record: SceneGenerationInputsDTO['relations'][number]['record']
  ): SceneGenerationInputsDTO['relations'][number] => ({
    relationId,
    fromCardId: 'card-a',
    toCardId: 'document-1',
    defaultRelation: 'associated',
    specificName,
    record
  })
  const rendered = toRenderStatusVO(
    projectionExecution({
      inputSnapshot: {
        ...emptyInputs(),
        documents: [
          {
            id: 'document-1',
            sourceId: 'canvas-document-1',
            title: '角色与场景',
            summary: '',
            body: '',
            topics: [],
            usage: { targetIds: [] }
          }
        ],
        prompts: [
          {
            id: 'prompt-1',
            title: '基础生成',
            body: '',
            scopes: [{ kind: 'scene' }],
            references: [],
            usage: { targetIds: [] }
          }
        ],
        relations: [
          relation('relation-1', '本场提示词', {
            kind: 'document',
            cardId: 'document-1',
            sourceId: 'canvas-document-1'
          }),
          relation('relation-2', '本场提示词', { kind: 'prompt', cardId: 'prompt-1' }),
          relation('relation-3', '本场提示词', {
            kind: 'document',
            cardId: 'document-1',
            sourceId: 'canvas-document-1'
          }),
          relation('relation-4', '林晚与场景', null)
        ]
      }
    })
  )
  expect(rendered.inputSummary.details?.relations).toEqual([
    '本场提示词 1（记录：文档）',
    '本场提示词 2（记录：提示词）',
    '本场提示词 3（记录：文档）',
    '林晚与场景'
  ])
})

it('重复文档标题按数据顺序编号，唯一标题保持原样', () => {
  const document = (
    id: string,
    title: string
  ): SceneGenerationInputsDTO['documents'][number] => ({
    id,
    sourceId: `source-${id}`,
    title,
    summary: '',
    body: '',
    topics: [],
    usage: { targetIds: [] }
  })
  const rendered = toRenderStatusVO(
    projectionExecution({
      inputSnapshot: {
        ...emptyInputs(),
        documents: [
          document('document-1', '角色与场景'),
          document('document-2', '角色与场景'),
          document('document-3', '世界观')
        ]
      }
    })
  )
  expect(rendered.inputSummary.details?.documents).toEqual([
    '角色与场景 1',
    '角色与场景 2',
    '世界观'
  ])
})

it('重名编号后单条明细仍不超过 80 字符', () => {
  const longTitle = 'x'.repeat(60)
  const prompt = (id: string): SceneGenerationInputsDTO['prompts'][number] => ({
    id,
    title: longTitle,
    body: '',
    scopes: Array.from({ length: 20 }, (_, index) => ({
      kind: 'relation' as const,
      relationId: `relation-${index}`
    })),
    references: [],
    usage: { targetIds: [] }
  })
  const details =
    toRenderStatusVO(
      projectionExecution({
        inputSnapshot: { ...emptyInputs(), prompts: [prompt('prompt-1'), prompt('prompt-2')] }
      })
    ).inputSummary.details?.prompts ?? []
  expect(details).toHaveLength(2)
  expect(details[0]?.startsWith(`${'x'.repeat(40)} 1`)).toBe(true)
  expect(details.every((detail) => detail.length <= 80)).toBe(true)
})

function emptyInputs(): SceneGenerationInputsDTO {
  return {
    canvasId: 'canvas-1',
    arrangementVersion: 'saved-version',
    assets: [],
    documents: [],
    prompts: [],
    fieldBindings: [],
    relations: [],
    confirmedControls: []
  }
}

function detailInputs(): SceneGenerationInputsDTO {
  return {
    ...emptyInputs(),
    documents: [
      {
        id: 'document-1',
        sourceId: 'canvas-document-1',
        title: '角色与场景',
        summary: '文档正文不应进入输入摘要',
        body: '文档正文不应进入输入摘要',
        topics: ['角色'],
        usage: { targetIds: [] }
      },
      {
        id: 'document-2',
        sourceId: 'canvas-document-2',
        title: '世界观',
        summary: '',
        body: '',
        topics: [],
        usage: { targetIds: [] }
      }
    ],
    prompts: [
      {
        id: 'prompt-1',
        title: '基础生成',
        body: '',
        scopes: [{ kind: 'scene' }],
        references: [],
        usage: { targetIds: [] }
      },
      {
        id: 'prompt-2',
        title: '卡片提示',
        body: '',
        scopes: [
          { kind: 'cards', cardIds: ['card-a', 'card-b'] },
          { kind: 'relation', relationId: 'relation-1' }
        ],
        references: [],
        usage: { targetIds: [] }
      }
    ],
    relations: [
      {
        relationId: 'relation-1',
        fromCardId: 'card-a',
        toCardId: 'document-1',
        defaultRelation: 'associated',
        specificName: '林晚与场景',
        record: { kind: 'document', cardId: 'document-1', sourceId: 'canvas-document-1' }
      },
      {
        relationId: 'relation-2',
        fromCardId: 'card-b',
        toCardId: 'document-1',
        defaultRelation: 'associated',
        specificName: '  ',
        record: { kind: 'document', cardId: 'document-1', sourceId: 'canvas-document-1' }
      },
      {
        relationId: 'relation-3',
        fromCardId: 'card-c',
        toCardId: 'prompt-1',
        defaultRelation: 'associated',
        specificName: '',
        record: { kind: 'prompt', cardId: 'prompt-1' }
      },
      {
        relationId: 'relation-4',
        fromCardId: 'card-d',
        toCardId: 'card-e',
        defaultRelation: 'associated',
        specificName: '',
        record: null
      }
    ]
  }
}

function projectionExecution(
  patch: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'D:/secret/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'failed',
    step: undefined,
    attempt: 1,
    sequence: 3,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    ...patch
  }
}
