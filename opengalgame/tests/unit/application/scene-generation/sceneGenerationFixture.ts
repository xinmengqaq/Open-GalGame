import type { SceneGenerationMemoryService } from '@application/scene-generation/services/SceneGenerationMemoryService'
import type { SceneGenerationCandidateEditService } from '@application/scene-generation/services/SceneGenerationCandidateEditService'
import type { SceneGenerationHistoryQueryService } from '@application/scene-generation/services/SceneGenerationHistoryQueryService'
import type { SceneGenerationStatusQueryService } from '@application/scene-generation/services/SceneGenerationStatusQueryService'
import type { SceneGenerationApplicationService } from '@application/scene-generation/services/SceneGenerationApplicationService'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies,
  type SceneGenerationDispatchIdentity
} from '@application/scene-generation/services/impl/SceneGenerationCoordinator'
import { SceneGenerationApplicationServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationApplicationServiceImpl'
import { SceneGenerationMemoryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationMemoryServiceImpl'
import { SceneGenerationCandidateEditServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationCandidateEditServiceImpl'
import { SceneGenerationHistoryQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationHistoryQueryServiceImpl'
import { SceneGenerationStatusQueryServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationStatusQueryServiceImpl'
import type { SceneGenerationWorkspaceGateway } from '@application/scene-generation/ports/SceneGenerationWorkspaceGateway'
import type { SceneGenerationMemoryGateway } from '@application/scene-generation/ports/SceneGenerationMemoryGateway'
import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import type { SceneGenerationSceneHistoryReader } from '@application/scene-generation/ports/SceneGenerationSceneHistoryReader'
import { vi, type Mocked } from 'vitest'

import type { GenerateSceneDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidate,
  SceneGenerationCommitState,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { SceneGenerationWorkflow } from '@application/scene-generation/ports/SceneGenerationWorkflow'
import type { SceneInputGateway } from '@application/scene-generation/ports/SceneInputGateway'
import type { SceneVersionGateway } from '@application/scene-generation/ports/SceneVersionGateway'
import { SceneGenerationApplicationServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationApplicationServiceImpl'
import type { SceneGenerationProgressVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { phaseOf } from '@application/scene-generation/mapping/SceneGenerationStateProjection'

type TestServices = SceneGenerationApplicationService &
  SceneGenerationStatusQueryService &
  SceneGenerationHistoryQueryService &
  SceneGenerationCandidateEditService &
  SceneGenerationMemoryService

export const generationRequest: GenerateSceneDTO = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  operationId: 'operation-1',
  inputs: { canvasId: 'canvas-1', confirmedControls: [] },
  policy: { maxCorrections: 2 }
}

export const waitingInteraction = {
  interactionId: 'interaction-1',
  checkpointId: 'checkpoint-1',
  kind: 'review' as const,
  message: '是否接受这个候选？',
  options: [],
  allowedReplies: ['accept', 'revise', 'discard'] as const,
  candidateSnapshotId: 'snapshot-1'
}

export const questionInteraction = {
  interactionId: 'interaction-1',
  checkpointId: 'checkpoint-1',
  kind: 'decision' as const,
  message: '请回答这组创作问题',
  options: [],
  questions: [1, 2].map((index) => ({
    questionId: `q${index}`,
    prompt: `问题 ${index}`,
    options: [1, 2, 3].map((option) => ({
      id: `q${index}o${option}`,
      label: `选项 ${option}`,
      description: `说明 ${option}`
    }))
  })),
  allowedReplies: ['answers', 'discard'] as const,
  candidateSnapshotId: 'snapshot-1'
}
/** 建立仅使用内存替身的应用编排夹具，不实现文件、Git 或工作流技术适配。 */
export interface SceneGenerationTestFixture {
  service: TestServices
  generation: SceneGenerationApplicationServiceImpl
  coordinator: SceneGenerationCoordinator
  deps: SceneGenerationDependencies
  workflow: Mocked<
    SceneGenerationWorkflow &
      SceneGenerationExecutionRepository &
      SceneGenerationHistoryReader &
      SceneGenerationSceneHistoryReader &
      SceneGenerationMemoryGateway
  >
  input: Mocked<SceneInputGateway>
  artifacts: Mocked<SceneArtifactGateway & SceneGenerationWorkspaceGateway>
  versions: Mocked<SceneVersionGateway>
  executions: Map<string, SceneGenerationExecution>
  commits: Map<string, SceneGenerationCommitState>
  jobs: (() => Promise<void>)[]
  dispatches: SceneGenerationDispatchIdentity[]
  progress: SceneGenerationProgressVO[]
  candidate: SceneGenerationCandidate
  ready: SceneGenerationWorkflowOutcome
  advanceTime: (milliseconds: number) => void
  runNext: () => Promise<void>
  restart: () => TestServices
}

export function createSceneGenerationFixture(): SceneGenerationTestFixture {
  const executions = new Map<string, SceneGenerationExecution>()
  const commits = new Map<string, SceneGenerationCommitState>()
  const jobs: (() => Promise<void>)[] = []
  const dispatches: SceneGenerationDispatchIdentity[] = []
  const progress: SceneGenerationProgressVO[] = []
  let nextIdentity = 0
  let currentTime = 1000
  const candidate: SceneGenerationCandidate = {
    candidateSnapshotId: 'snapshot-1',
    artifact: {
      scene: { projectId: 'project-1', sceneId: 'scene-1' },
      hasEntry: true,
      statements: [
        {
          sequence: 1,
          command: 'say',
          commandRecognition: 'recognized',
          argumentRecognition: 'recognized',
          content: '你好',
          assetUses: []
        }
      ]
    },
    preview: {
      entryFile: 'scenes/scene-1/start.txt',
      files: ['scenes/scene-1/start.txt'],
      parserVersion: '4.6.5',
      commandLocations: [
        { sequence: 1, filePath: 'scenes/scene-1/start.txt', line: 1, engineSentenceIndex: 0 }
      ],
      assetLocations: [],
      validationReport: { issues: [] }
    },
    assetChanges: ['assets/new-background.webp']
  }
  const ready: SceneGenerationWorkflowOutcome = {
    state: 'ready',
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    budget: { correctionsUsed: 0, modelCallsUsed: 1, toolCallsUsed: 2, activeElapsedMs: 0 }
  }
  const workflow = {
    readExecution: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['readExecution']
    >(async (scope) => {
      const execution = executions.get(scope.operationId)
      return execution &&
        execution.projectId === scope.projectId &&
        execution.sceneId === scope.sceneId
        ? structuredClone(execution)
        : null
    }),
    findActiveExecution: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['findActiveExecution']
    >(
      async (scope) =>
        [...executions.values()].find(
          (execution) =>
            execution.projectId === scope.projectId &&
            execution.sceneId === scope.sceneId &&
            execution.threadId === scope.threadId &&
            !['succeeded', 'failed', 'cancelled'].includes(execution.state)
        ) ?? null
    ),
    listSceneExecutions: vi.fn<SceneGenerationSceneHistoryReader['listSceneExecutions']>(
      async (request) =>
        [...executions.values()].filter(
          (execution) =>
            execution.projectId === request.projectId && execution.sceneId === request.sceneId
        )
    ),
    createExecution: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['createExecution']
    >(async (execution) => {
      executions.set(execution.operationId, structuredClone(execution))
      return structuredClone(execution)
    }),
    writeExecution: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['writeExecution']
    >(async (execution) => {
      executions.set(execution.operationId, structuredClone(execution))
      return structuredClone(execution)
    }),
    executeGeneration: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['executeGeneration']
    >(async () => ready),
    resumeGeneration: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['resumeGeneration']
    >(async () => ready),
    continueInteraction: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['continueInteraction']
    >(async () => ready),
    forkGeneration: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['forkGeneration']
    >(async () => ready),
    listHistory: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['listHistory']
    >(async () => ({
      branches: [],
      checkpoints: []
    })),
    readCheckpoint: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['readCheckpoint']
    >(async (request) => {
      const execution = [...executions.values()].find(
        (operation) =>
          operation.threadId === request.threadId && operation.branchId === request.branchId
      )!
      return {
        execution,
        candidateSnapshotId: execution.candidateSnapshotId,
        summary: '来源摘要',
        unresolvedIssues: ['未解决冲突'],
        view: {
          projectId: request.projectId,
          sceneId: request.sceneId,
          threadId: request.threadId,
          branchId: request.branchId,
          operationId: execution.operationId,
          checkpointId: request.checkpointId,
          phase: phaseOf(execution.state, execution.step),
          summary: '检查点',
          decisions: [],
          differences: [],
          canView: true,
          canContinue: true
        }
      }
    }),
    clearMemory: vi.fn<
      (SceneGenerationWorkflow &
        SceneGenerationExecutionRepository &
        SceneGenerationHistoryReader &
        SceneGenerationSceneHistoryReader &
        SceneGenerationMemoryGateway)['clearMemory']
    >(async () => {})
  }
  const input = {
    locateScene: vi.fn<SceneInputGateway['locateScene']>(async (scene) => ({
      ...scene,
      projectRoot: '/project',
      sceneDirectory: 'scenes/scene-1',
      entryFile: 'start.txt'
    })),
    readInputs: vi.fn<SceneInputGateway['readInputs']>(async () => ({
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [
        {
          assetId: 'background-1',
          sourceId: 'canvas-asset-1',
          name: '车站',
          relativePath: 'assets/station.webp',
          category: 'image',
          description: '黄昏车站',
          usage: { targetIds: [] }
        }
      ],
      documents: [
        {
          id: 'document-1',
          sourceId: 'canvas-document-1',
          title: '角色',
          summary: '',
          body: '林是学生',
          topics: ['角色'],
          usage: { targetIds: [] }
        }
      ],
      prompts: [
        {
          id: 'prompt-1',
          title: '道别',
          body: '在车站道别',
          scopes: [{ kind: 'scene' }],
          references: [],
          usage: { targetIds: [] }
        }
      ],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    }))
  }
  const artifacts = {
    saveCandidateRevision: vi.fn<SceneArtifactGateway['saveCandidateRevision']>(async () => ({
      candidateSnapshotId: 'snapshot-1'
    })),
    writeCandidateFiles: vi.fn<
      (SceneArtifactGateway & SceneGenerationWorkspaceGateway)['writeCandidateFiles']
    >(async () => ({
      candidateSnapshotId: 'snapshot-2'
    })),
    createWorkspace: vi.fn<
      (SceneArtifactGateway & SceneGenerationWorkspaceGateway)['createWorkspace']
    >(async (execution) => ({
      workspaceId: execution.operationId,
      rootDirectory: '/candidate/' + execution.operationId,
      sceneDirectory: 'scenes/scene-1'
    })),
    restoreWorkspace: vi.fn<
      (SceneArtifactGateway & SceneGenerationWorkspaceGateway)['restoreWorkspace']
    >(async (execution) => ({
      workspaceId: execution.operationId,
      rootDirectory: '/restored/' + execution.operationId,
      sceneDirectory: 'scenes/scene-1'
    })),
    materializeRepairInput: vi.fn<
      (SceneArtifactGateway & SceneGenerationWorkspaceGateway)['materializeRepairInput']
    >(async (execution) => {
      if (execution.repairSource?.threadId === execution.threadId) {
        throw new Error('不能把来源修订当作新线程候选')
      }
      return {
        workspaceId: execution.operationId,
        rootDirectory: '/repair/' + execution.operationId,
        sceneDirectory: 'scenes/scene-1',
        candidateSnapshotId: 'repair-input-1'
      }
    }),
    readCandidate: vi.fn<(SceneArtifactGateway & SceneGenerationWorkspaceGateway)['readCandidate']>(
      async () => candidate
    ),
    discardWorkspace: vi.fn<
      (SceneArtifactGateway & SceneGenerationWorkspaceGateway)['discardWorkspace']
    >(async () => {})
  }
  const versions = {
    readBaseline: vi.fn<SceneVersionGateway['readBaseline']>(async () => ({
      commitId: 'baseline-1',
      affectedFiles: [{ relativePath: 'scenes/scene-1/start.txt', digest: 'original' }],
      lockState: 'unlocked'
    })),
    ensureWorkspace: vi.fn<SceneVersionGateway['ensureWorkspace']>(async (projectId) => ({
      projectId,
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })),
    inspectBaseline: vi.fn<SceneVersionGateway['inspectBaseline']>(async () => ({
      baselineState: 'unchanged',
      lockState: 'unlocked'
    })),
    commitCandidate: vi.fn<SceneVersionGateway['commitCandidate']>(
      async (execution, candidateFiles, requireVersion) => {
        requireVersion({ baselineState: 'unchanged', lockState: 'unlocked' })
        const commitId = 'commit-' + execution.operationId
        commits.set(execution.operationId, { state: 'committed', commitId })
        return { commitId }
      }
    ),
    readOperationCommit: vi.fn<SceneVersionGateway['readOperationCommit']>(
      async (scope) => commits.get(scope.operationId) ?? { state: 'notCommitted' }
    ),
    rollbackCandidate: vi.fn<SceneVersionGateway['rollbackCandidate']>(async () => ({
      rollbackCommitId: 'rollback-1'
    }))
  }
  const deps = {
    workflow,
    executions: workflow,
    history: workflow,
    memory: workflow,
    workspace: artifacts,
    input,
    artifacts,
    versions,
    candidatePreview: undefined,
    nextId: (): string => 'identity-' + ++nextIdentity,
    now: (): number => currentTime,
    /** 缓冲后台事务及其操作身份，供测试显式执行和核对关联。 */
    dispatch: (job: () => Promise<void>, identity: SceneGenerationDispatchIdentity): void => {
      jobs.push(job)
      dispatches.push(identity)
    },
    /** 收集已经持久记录的进度。 */
    publishProgress: (event: SceneGenerationProgressVO): void => {
      progress.push(event)
    }
  }
  let generation!: SceneGenerationApplicationServiceImpl
  let coordinator!: SceneGenerationCoordinator
  const createServices = (): TestServices => {
    coordinator = new SceneGenerationCoordinator(deps)
    generation = new SceneGenerationApplicationServiceImpl(deps, coordinator)
    const s1 = new SceneGenerationStatusQueryServiceImpl(deps, coordinator)
    const s2 = new SceneGenerationHistoryQueryServiceImpl(workflow, workflow)
    const s3 = new SceneGenerationCandidateEditServiceImpl(deps, coordinator, deps.candidatePreview)
    const s4 = new SceneGenerationMemoryServiceImpl(deps, coordinator)
    return {
      generateScene: generation.generateScene.bind(generation),
      cancelSceneGeneration: generation.cancelSceneGeneration.bind(generation),
      replySceneGenerationInteraction: generation.replySceneGenerationInteraction.bind(generation),
      resumeSceneGeneration: generation.resumeSceneGeneration.bind(generation),
      forkSceneGeneration: generation.forkSceneGeneration.bind(generation),
      getSceneGenerationStatus: s1.getSceneGenerationStatus.bind(s1),
      listSceneGenerationHistory: s2.listSceneGenerationHistory.bind(s2),
      readSceneGenerationCheckpoint: s2.readSceneGenerationCheckpoint.bind(s2),
      listSceneGenerationHistoryForScene: s2.listSceneGenerationHistoryForScene.bind(s2),
      editSceneGenerationCandidate: s3.editSceneGenerationCandidate.bind(s3),
      clearSceneGenerationMemory: s4.clearSceneGenerationMemory.bind(s4)
    }
  }
  const service = createServices()
  return {
    service,
    generation,
    coordinator,
    deps,
    workflow,
    input,
    artifacts,
    versions,
    executions,
    commits,
    jobs,
    dispatches,
    progress,
    candidate,
    ready,
    advanceTime: (milliseconds: number): void => {
      currentTime += milliseconds
    },
    /**
     * 执行下一个后台事务，失败直接交给断言。
     * @throws {Error} 没有待执行事务或事务失败。
     */
    runNext: async (): Promise<void> => {
      const job = jobs.shift()
      if (!job) throw new Error('没有待执行任务')
      await job()
    },
    /** 重新创建应用服务，保留替身持久事实，清空本进程活动表。 */
    restart: (): TestServices => createServices()
  }
}

export function waitForInteraction(fixture: ReturnType<typeof createSceneGenerationFixture>): void {
  fixture.workflow.executeGeneration.mockResolvedValueOnce({
    ...fixture.ready,
    state: 'waiting',
    interaction: waitingInteraction
  })
}

/**
 * 提供执行期间可通过取消信号终止的可控工作流。
 * @returns 仅在被取消时结束的结果。
 */
export function waitForCancellation(
  runtime: SceneGenerationRuntime
): Promise<SceneGenerationWorkflowOutcome> {
  return new Promise((resolve, reject) => {
    if (runtime.signal.aborted) reject(runtime.signal.reason)
    else
      runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), { once: true })
  })
}
