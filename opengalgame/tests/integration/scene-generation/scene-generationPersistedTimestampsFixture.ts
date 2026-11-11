import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mocked } from 'vitest'

import type {
  GenerateSceneDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationInteractionVO,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import { phaseOf } from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import type { SceneGenerationMemoryGateway } from '@application/scene-generation/ports/SceneGenerationMemoryGateway'
import type { SceneGenerationWorkspaceGateway } from '@application/scene-generation/ports/SceneGenerationWorkspaceGateway'
import type { SceneGenerationWorkflow } from '@application/scene-generation/ports/SceneGenerationWorkflow'
import type { SceneInputGateway } from '@application/scene-generation/ports/SceneInputGateway'
import type { SceneVersionGateway } from '@application/scene-generation/ports/SceneVersionGateway'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies
} from '@application/scene-generation/services/impl/SceneGenerationCoordinator'
import { SceneGenerationApplicationServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationApplicationServiceImpl'
import type { SceneGenerationProgressVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import {
  ensureStateRoot,
  resolveStatePath
} from '@infrastructure/workflow/checkpoints/checkpointPath'

const roots: string[] = []

export const request: GenerateSceneDTO = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  operationId: 'operation-1',
  inputs: { canvasId: 'canvas-1', confirmedControls: [] },
  policy: { maxCorrections: 1 }
}

export const interaction: SceneGenerationInteractionVO = {
  interactionId: 'interaction-1',
  checkpointId: 'checkpoint-1',
  kind: 'review',
  message: '是否接受这个候选？',
  options: [],
  allowedReplies: ['accept', 'revise', 'discard'],
  candidateSnapshotId: 'snapshot-1'
}

export const staleUpdatedAt = '2000-01-01T00:00:00.000Z'

export interface Harness {
  stateRoot: string
  repository: FileSceneGenerationExecutionRepositoryImpl
  coordinator: SceneGenerationCoordinator
  service: SceneGenerationApplicationServiceImpl
  workflow: Mocked<SceneGenerationWorkflow>
  progress: SceneGenerationProgressVO[]
  runNext: () => Promise<void>
}

export async function cleanupHarnessRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

/** 使用真实文件仓库，其余端口保持可控，供仓库与协调器验证。 */
export async function createHarness(): Promise<Harness> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'scene-generation-timestamps-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const jobs: (() => Promise<void>)[] = []
  const progress: SceneGenerationProgressVO[] = []
  const workflow: Mocked<SceneGenerationWorkflow> = {
    executeGeneration: vi.fn<SceneGenerationWorkflow['executeGeneration']>(),
    resumeGeneration: vi.fn<SceneGenerationWorkflow['resumeGeneration']>(),
    continueInteraction: vi.fn<SceneGenerationWorkflow['continueInteraction']>(),
    forkGeneration: vi.fn<SceneGenerationWorkflow['forkGeneration']>()
  }
  const history: SceneGenerationHistoryReader = {
    listHistory: async () => ({ branches: [], checkpoints: [] }),
    readCheckpoint: async (scope: ReadSceneGenerationCheckpointDTO) => {
      const execution = await repository.readExecution(scope)
      if (!execution) throw new Error('检查点执行记录不存在')
      return {
        execution,
        candidateSnapshotId: execution.candidateSnapshotId,
        view: {
          projectId: execution.projectId,
          sceneId: execution.sceneId,
          threadId: execution.threadId,
          branchId: execution.branchId,
          operationId: execution.operationId,
          checkpointId: scope.checkpointId,
          phase: phaseOf(execution.state, execution.step),
          summary: '检查点',
          decisions: [],
          differences: [],
          canView: true,
          canContinue: true
        }
      }
    }
  }
  const input: SceneInputGateway = {
    locateScene: async (scene) => ({
      ...scene,
      projectRoot: '/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    }),
    readInputs: async () => ({
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    })
  }
  const versions: SceneVersionGateway = {
    readBaseline: async () => ({ commitId: 'baseline-1', affectedFiles: [], lockState: 'unlocked' }),
    ensureWorkspace: async (projectId) => ({ projectId, sceneId: 'scene-1', canvasId: 'canvas-1' }),
    inspectBaseline: async () => ({ baselineState: 'unchanged', lockState: 'unlocked' }),
    commitCandidate: async (execution) => ({ commitId: `commit-${execution.operationId}` }),
    readOperationCommit: async () => ({ state: 'notCommitted' }),
    rollbackCandidate: async () => ({ rollbackCommitId: 'rollback-1' })
  }
  const workspace: SceneGenerationWorkspaceGateway = {
    createWorkspace: async (execution) => ({
      workspaceId: execution.operationId,
      rootDirectory: '/candidate/' + execution.operationId,
      sceneDirectory: 'game/scene'
    }),
    restoreWorkspace: async (execution) => ({
      workspaceId: execution.operationId,
      rootDirectory: '/restored/' + execution.operationId,
      sceneDirectory: 'game/scene'
    }),
    materializeRepairInput: async (execution) => ({
      workspaceId: execution.operationId,
      rootDirectory: '/repair/' + execution.operationId,
      sceneDirectory: 'game/scene',
      candidateSnapshotId: 'repair-input-1'
    }),
    discardWorkspace: async () => {}
  }
  const artifacts: SceneArtifactGateway = {
    writeCandidateFiles: async () => ({ candidateSnapshotId: 'snapshot-2' }),
    readCandidate: async () => {
      throw new Error('本用例不读取候选')
    },
    saveCandidateRevision: async () => ({ candidateSnapshotId: 'snapshot-2' })
  }
  const memory: SceneGenerationMemoryGateway = { clearMemory: async () => {} }
  let currentTime = Date.parse('2026-10-30T00:00:00.000Z')
  let nextIdentity = 0
  const deps: SceneGenerationDependencies = {
    input,
    workflow,
    executions: repository,
    history,
    memory,
    workspace,
    artifacts,
    versions,
    nextId: () => 'identity-' + ++nextIdentity,
    now: () => (currentTime += 1000),
    dispatch: (job) => {
      jobs.push(job)
    },
    publishProgress: (event) => {
      progress.push(event)
    }
  }
  const coordinator = new SceneGenerationCoordinator(deps)
  const service = new SceneGenerationApplicationServiceImpl(deps, coordinator)
  return {
    stateRoot,
    repository,
    coordinator,
    service,
    workflow,
    progress,
    runNext: async () => {
      const job = jobs.shift()
      if (!job) throw new Error('没有待执行任务')
      await job()
    }
  }
}

export function waitingOutcome(): SceneGenerationWorkflowOutcome {
  return {
    state: 'waiting',
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    interaction,
    budget: { correctionsUsed: 0, modelCallsUsed: 1, toolCallsUsed: 1, activeElapsedMs: 0 }
  }
}

export function executionFact(): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint-1',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'baseline-1', affectedFiles: [], lockState: 'unlocked' },
    state: 'pending',
    step: 'preparing',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  }
}

export function replyRequest(
  execution: SceneGenerationExecution
): ReplySceneGenerationInteractionDTO {
  if (!execution.interaction) throw new Error('等待记录缺少交互')
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    interactionId: execution.interaction.interactionId,
    checkpointId: execution.interaction.checkpointId,
    candidateSnapshotId: execution.interaction.candidateSnapshotId,
    replyId: 'reply-1',
    reply: { kind: 'accept' }
  }
}

export async function ageStoredTimes(stateRoot: string, updatedAt: string): Promise<void> {
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const value = JSON.parse(await readFile(path, 'utf8')) as {
    executions: Array<{ operationId: string; updatedAt?: string }>
  }
  const item = value.executions.find((execution) => execution.operationId === 'operation-1')
  if (!item) throw new Error('待覆盖执行记录不存在')
  item.updatedAt = updatedAt
  await writeFile(path, JSON.stringify(value))
}
