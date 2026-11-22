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
import { RunSceneGeneration } from '@application/scene-generation/services/impl/RunSceneGeneration'
import { ControlSceneGeneration } from '@application/scene-generation/services/impl/ControlSceneGeneration'
import { ClearSceneGenerationMemory } from '@application/scene-generation/services/impl/ClearSceneGenerationMemory'
import { EditSceneGenerationCandidate } from '@application/scene-generation/services/impl/EditSceneGenerationCandidate'
import { QuerySceneGenerationHistory } from '@application/scene-generation/services/impl/QuerySceneGenerationHistory'
import { QuerySceneGenerationStatus } from '@application/scene-generation/services/impl/QuerySceneGenerationStatus'
import type { SceneGenerationWorkspaceGateway } from '@application/scene-generation/ports/SceneGenerationWorkspaceGateway'
import type {
  ForkSourceEvidence,
  ForkSourceVerification,
  SceneGenerationForkSourceEvidence
} from '@application/scene-generation/ports/SceneGenerationForkSourceEvidence'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import type { SceneGenerationMemoryGateway } from '@application/scene-generation/ports/SceneGenerationMemoryGateway'
import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import type { SceneGenerationSceneHistoryReader } from '@application/scene-generation/ports/SceneGenerationSceneHistoryReader'
import { vi, type Mocked } from 'vitest'
import { createHash } from 'node:crypto'

import type { GenerateSceneDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidate,
  SceneGenerationCheckpoint,
  SceneGenerationCommitState,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { SceneGenerationWorkflow } from '@application/scene-generation/ports/SceneGenerationWorkflow'
import {
  isPiReviewCheckpointId,
  piReviewCheckpointId
} from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import type { SceneInputGateway } from '@application/scene-generation/ports/SceneInputGateway'
import type { SceneVersionGateway } from '@application/scene-generation/ports/SceneVersionGateway'
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
export interface SceneGenerationTestFixture {
  service: TestServices
  generation: RunSceneGeneration
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
  /** 当前装配实例的控制服务；重开后使用新协调器与新的应用服务。 */
  control: () => ControlSceneGeneration
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * 单元夹具的状态化来源证据：与真实存储同一端口契约，捕获时核对来源检查点身份并只写一次，
 * 重开只按已保存证据与当前分叉身份核对；不依赖文件或 Git 技术适配。
 */
function createStatefulForkSourceEvidence(): SceneGenerationForkSourceEvidence {
  const records = new Map<string, ForkSourceEvidence>()
  return {
    async capture(execution, checkpoint): Promise<void> {
      const fork = execution.fork
      const sourceOperationId = fork?.sourceOperationId
      if (!fork || !execution.forkRequest || sourceOperationId === undefined)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '分叉执行缺少来源身份'
        })
      if (checkpoint.view.canFork !== true)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: checkpoint.view.reason ?? '来源检查点当前不能分叉'
        })
      if (
        checkpoint.execution.operationId !== sourceOperationId ||
        checkpoint.execution.projectId !== execution.projectId ||
        checkpoint.execution.sceneId !== execution.sceneId ||
        checkpoint.execution.threadId !== execution.threadId ||
        checkpoint.execution.branchId !== fork.branchId ||
        checkpoint.view.checkpointId !== fork.checkpointId ||
        fork.branchId === execution.branchId ||
        sourceOperationId === execution.operationId
      )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '来源检查点身份与分叉记录不一致'
        })
      const candidateSnapshotId = checkpoint.candidateSnapshotId
      if (
        candidateSnapshotId === undefined ||
        fork.candidateSnapshotId !== candidateSnapshotId ||
        checkpoint.execution.candidateSnapshotId !== candidateSnapshotId
      )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '来源候选修订与分叉记录不一致'
        })
      const inputSnapshotDigest = digestOf(checkpoint.execution.inputSnapshot)
      if (!execution.forkRequest.inputChanges && digestOf(execution.inputSnapshot) !== inputSnapshotDigest)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '分叉输入与来源输入不一致'
        })
      const fields: Omit<ForkSourceEvidence, 'digest'> = {
        version: 1,
        operationId: execution.operationId,
        projectId: execution.projectId,
        sceneId: execution.sceneId,
        threadId: execution.threadId,
        sourceOperationId,
        sourceBranchId: checkpoint.execution.branchId,
        checkpointId: fork.checkpointId,
        candidateSnapshotId,
        checkpointKind: isPiReviewCheckpointId(fork.checkpointId) ? 'pi-review' : 'legacy',
        checkpointDigest: digestOf({
          view: checkpoint.view,
          execution: checkpoint.execution,
          candidateSnapshotId
        }),
        inputSnapshotDigest,
        revision: {
          revisionId: candidateSnapshotId,
          treeId: createHash('sha256')
            .update(`tree:${sourceOperationId}:${candidateSnapshotId}`)
            .digest('hex')
            .slice(0, 40),
          parentRevisionIds: []
        }
      }
      const evidence: ForkSourceEvidence = { ...fields, digest: digestOf(fields) }
      const existing = records.get(execution.operationId)
      if (existing !== undefined) {
        if (existing.digest !== evidence.digest)
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '分叉来源证据已存在且不一致，不能覆盖现场'
          })
        return
      }
      records.set(execution.operationId, evidence)
    },
    async verify(execution, revisionId): Promise<ForkSourceVerification> {
      const evidence = records.get(execution.operationId)
      if (evidence === undefined)
        return { ok: false, reason: '分叉来源证据缺失，已保留现场待核对' }
      const fork = execution.fork
      if (
        !fork ||
        fork.sourceOperationId !== evidence.sourceOperationId ||
        fork.branchId !== evidence.sourceBranchId ||
        fork.checkpointId !== evidence.checkpointId ||
        fork.candidateSnapshotId !== evidence.candidateSnapshotId ||
        execution.projectId !== evidence.projectId ||
        execution.sceneId !== evidence.sceneId ||
        execution.threadId !== evidence.threadId
      )
        return { ok: false, reason: '分叉来源证据与持久分叉记录不一致' }
      if (revisionId !== undefined && evidence.candidateSnapshotId !== revisionId)
        return { ok: false, reason: '待证明的父修订不是创建分叉时复制的来源候选' }
      return { ok: true, evidence }
    }
  }
}

export function createSceneGenerationFixture(
  domain: SceneGenerationDomainService = new SceneGenerationDomainServiceImpl()
): SceneGenerationTestFixture {
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
    listProjectExecutions: vi.fn(async (projectId: string) =>
      [...executions.values()]
        .filter((execution) => execution.projectId === projectId)
        .map((execution) => structuredClone(execution))
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
    capabilities: vi.fn<SceneGenerationWorkflow['capabilities']>(() => ({
      resume: true,
      pause: true,
      continueInteraction: true,
      fork: true
    })),
    /** 与真实工作流同一身份契约：同一操作与候选修订得到稳定审阅边界，应用只当不透明标识。 */
    checkpointIdFor: vi.fn<SceneGenerationWorkflow['checkpointIdFor']>((execution) =>
      piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId)
    ),
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
          canContinue: true,
          canFork: true,
          canReply: true
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
    proveRepairInput: vi.fn<
      (SceneArtifactGateway & SceneGenerationWorkspaceGateway)['proveRepairInput']
    >(async () => undefined),
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
    domain,
    workflow,
    executions: workflow,
    history: workflow,
    memory: workflow,
    workspace: artifacts,
    input,
    artifacts,
    versions,
    writeRecovery: {
      recoverCandidateWrite: async () => ({ outcome: 'notApplicable' as const })
    },
    forkSourceEvidence: createStatefulForkSourceEvidence(),
    candidatePreview: undefined,
    nextId: (): string => 'identity-' + ++nextIdentity,
    now: (): number => currentTime,
    dispatch: (job: () => Promise<void>, identity: SceneGenerationDispatchIdentity): void => {
      jobs.push(job)
      dispatches.push(identity)
    },
    publishProgress: (event: SceneGenerationProgressVO): void => {
      progress.push(event)
    }
  }
  let generation!: RunSceneGeneration
  let coordinator!: SceneGenerationCoordinator
  const createServices = (): TestServices => {
    coordinator = new SceneGenerationCoordinator(deps)
    generation = new RunSceneGeneration(deps, coordinator)
    const s1 = new QuerySceneGenerationStatus(deps, coordinator)
    const s2 = new QuerySceneGenerationHistory(workflow, workflow)
    const s3 = new EditSceneGenerationCandidate(deps, coordinator, deps.candidatePreview)
    const s4 = new ClearSceneGenerationMemory(deps, coordinator)
    return {
      generateScene: generation.generateScene.bind(generation),
      cancelSceneGeneration: generation.cancelSceneGeneration.bind(generation),
      replySceneGenerationInteraction: generation.replySceneGenerationInteraction.bind(generation),
      resumeSceneGeneration: generation.resumeSceneGeneration.bind(generation),
      forkSceneGeneration: generation.forkSceneGeneration.bind(generation),
      getSceneGenerationStatus: s1.getSceneGenerationStatus.bind(s1),
      listSceneGenerationHistory: s2.listSceneGenerationHistory.bind(s2),
      readSceneGenerationCheckpoint: s2.readSceneGenerationCheckpoint.bind(s2),
      readSceneGenerationHistoryDetail: s2.readSceneGenerationHistoryDetail.bind(s2),
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
    runNext: async (): Promise<void> => {
      const job = jobs.shift()
      if (!job) throw new Error('没有待执行任务')
      await job()
    },
    restart: (): TestServices => createServices(),
    /** 按当前装配实例构造控制服务；重开后使用新的协调器与生成服务。 */
    control: (): ControlSceneGeneration => new ControlSceneGeneration(deps, coordinator, generation)
  }
}

export function waitForInteraction(fixture: ReturnType<typeof createSceneGenerationFixture>): void {
  fixture.workflow.executeGeneration.mockResolvedValueOnce({
    ...fixture.ready,
    state: 'waiting',
    interaction: waitingInteraction
  })
}

export function waitForCancellation(
  runtime: SceneGenerationRuntime
): Promise<SceneGenerationWorkflowOutcome> {
  return new Promise((resolve, reject) => {
    if (runtime.signal.aborted) reject(runtime.signal.reason)
    else
      runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), { once: true })
  })
}
