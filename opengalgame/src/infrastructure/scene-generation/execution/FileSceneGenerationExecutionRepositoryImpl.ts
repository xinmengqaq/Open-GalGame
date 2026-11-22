import {
  ensureStateRoot,
  resolveStatePath
} from '@infrastructure/workflow/checkpoints/checkpointPath'
import type { SceneGenerationExecutionRepository } from '@application/scene-generation/ports/SceneGenerationExecutionRepository'
import type { SceneGenerationSceneHistoryReader } from '@application/scene-generation/ports/SceneGenerationSceneHistoryReader'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  ListSceneGenerationHistoryForSceneDTO,
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import { isTerminal } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import {
  isActiveGenerationExecution,
  SCENE_GENERATION_START_CONFLICT_MESSAGE
} from '@application/scene-generation/policies/SceneGenerationStartConflict'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { withFileTurn } from '@infrastructure/storage/fileTurn'
import { assertWorkflowSegment } from '@infrastructure/workflow/WorkflowIdentity'
import { writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import {
  executionDocumentSchema,
  SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION
} from './SceneGenerationExecutionDocument'
import { readCurrentExecutionRecordFile } from './ExecutionRecordMigration'

const failure = { code: ErrorCodes.internalError, msg: '场景生成执行记录读写失败' }

export class FileSceneGenerationExecutionRepositoryImpl
  implements SceneGenerationExecutionRepository, SceneGenerationSceneHistoryReader
{
  constructor(private readonly stateRoot: string) {}

  async readExecution(scope: SceneGenerationScopeDTO): Promise<SceneGenerationExecution | null> {
    assertWorkflowSegment(scope.operationId, 'operationId')
    const result = (await this.readStored(scope.projectId)).find(
      (item) => item.operationId === scope.operationId
    )
    if (!result) return null
    if (result.sceneId !== scope.sceneId)
      throw new AppException({ code: ErrorCodes.forbidden, msg: '操作不属于当前场景' })
    return result
  }

  async findActiveExecution(
    scope: SceneGenerationThreadDTO
  ): Promise<SceneGenerationExecution | null> {
    const operations = (await this.readStored(scope.projectId)).filter(
      (item) => item.threadId === scope.threadId
    )
    this.requireThreadScene(operations, scope.sceneId)
    return operations.find((item) => !isTerminal(item)) ?? null
  }

  async createExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution> {
    const path = await this.projectPath(execution.projectId)
    return withFileTurn(path, async () => {
      const operations = await this.readStoredUnlocked(execution.projectId, path)
      // 分叉的来源可以停在等待/暂停位置；只允许这一种同线程未结束来源，
      // 其它运行中或额外未结束操作仍按单线程单活操作拒绝。
      const sourceOperationId = execution.fork?.sourceOperationId
      const activeInThread = operations.filter(
        (item) => item.threadId === execution.threadId && !isTerminal(item)
      )
      const forkFromWaitingSource =
        execution.forkRequest !== undefined &&
        sourceOperationId !== undefined &&
        activeInThread.length === 1 &&
        activeInThread[0].operationId === sourceOperationId &&
        (activeInThread[0].state === 'waiting' ||
          (activeInThread[0].state === 'interrupted' &&
            activeInThread[0].interruptReason === 'paused'))
      if (forkFromWaitingSource) {
        const source = activeInThread[0]
        if (
          execution.fork === undefined ||
          source.pendingReply !== undefined ||
          source.checkpointId !== execution.fork.checkpointId ||
          source.candidateSnapshotId !== execution.fork.candidateSnapshotId
        )
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '来源历史已变化，不能分叉'
          })
      }
      if (
        operations.some(
          (item) =>
            item.operationId === execution.operationId ||
            (item.threadId === execution.threadId &&
              !isTerminal(item) &&
              !forkFromWaitingSource)
        )
      )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '操作已存在或线程仍有未结束操作'
        })
      if (
        operations.some(
          (item) =>
            (item.threadId === execution.threadId && item.sceneId !== execution.sceneId) ||
            (item.branchId === execution.branchId && item.threadId !== execution.threadId)
        )
      )
        throw new AppException({ code: ErrorCodes.forbidden, msg: '线程或分支归属不匹配' })
      if (
        execution.mode === 'generate' &&
        operations.some(
          (item) =>
            item.sceneId === execution.sceneId &&
            isActiveGenerationExecution({ mode: item.mode, state: item.state })
        )
      )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: SCENE_GENERATION_START_CONFLICT_MESSAGE
        })
      const now = new Date().toISOString()
      const recorded: SceneGenerationExecution = {
        ...execution,
        createdAt: execution.createdAt ?? now,
        updatedAt: now
      }
      await this.writeStored(execution.projectId, [...operations, recorded])
      return recorded
    })
  }

  async writeExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution> {
    const path = await this.projectPath(execution.projectId)
    return withFileTurn(path, async () => {
      const operations = await this.readStoredUnlocked(execution.projectId, path)
      const index = operations.findIndex((item) => item.operationId === execution.operationId)
      const previous = operations[index]
      if (!previous)
        throw new AppException({ code: ErrorCodes.forbidden, msg: '执行记录归属不匹配' })
      if (
        previous.sceneId !== execution.sceneId ||
        previous.threadId !== execution.threadId ||
        previous.branchId !== execution.branchId ||
        previous.fingerprint !== execution.fingerprint
      )
        throw new AppException({ code: ErrorCodes.forbidden, msg: '执行记录归属不匹配' })
      const now = new Date().toISOString()
      const recorded: SceneGenerationExecution = {
        ...execution,
        createdAt: previous.createdAt ?? execution.createdAt ?? now,
        updatedAt: now
      }
      const next = [...operations]
      next[index] = recorded
      await this.writeStored(execution.projectId, next)
      return recorded
    })
  }

  async listThread(scope: SceneGenerationThreadDTO): Promise<SceneGenerationExecution[]> {
    assertWorkflowSegment(scope.threadId, 'threadId')
    const operations = (await this.readStored(scope.projectId)).filter(
      (item) => item.threadId === scope.threadId
    )
    this.requireThreadScene(operations, scope.sceneId)
    return [...operations]
  }

  async listSceneExecutions(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<SceneGenerationExecution[]> {
    return this.readSceneExecutions(request.projectId, request.sceneId)
  }

  /** 工程打开时按本工程记录清理已受理取消；不读取其它工程目录。 */
  async listProjectExecutions(projectId: string): Promise<SceneGenerationExecution[]> {
    assertWorkflowSegment(projectId, 'projectId')
    return [...(await this.readStored(projectId))]
  }

  async findLatestSceneExecution(
    projectId: string,
    sceneId: string
  ): Promise<SceneGenerationExecution | null> {
    let latest: SceneGenerationExecution | null = null
    let latestUpdatedAt = ''
    let latestCreatedAt = ''
    for (const execution of await this.readSceneExecutions(projectId, sceneId)) {
      const updatedAt = execution.updatedAt ?? execution.timeline?.at(-1)?.createdAt ?? ''
      const createdAt = execution.createdAt ?? ''
      if (
        latest === null ||
        updatedAt > latestUpdatedAt ||
        (updatedAt === latestUpdatedAt && createdAt >= latestCreatedAt)
      ) {
        latest = execution
        latestUpdatedAt = updatedAt
        latestCreatedAt = createdAt
      }
    }
    return latest
  }

  private async readSceneExecutions(
    projectId: string,
    sceneId: string
  ): Promise<SceneGenerationExecution[]> {
    assertWorkflowSegment(projectId, 'projectId')
    assertWorkflowSegment(sceneId, 'sceneId')
    return (await this.readStored(projectId)).flatMap((execution) =>
      execution.sceneId === sceneId &&
      (execution.updatedAt ?? execution.timeline?.at(-1)?.createdAt)
        ? [execution]
        : []
    )
  }

  private async readStored(projectId: string): Promise<readonly SceneGenerationExecution[]> {
    const path = await this.projectPath(projectId)
    return withFileTurn(path, () => this.readStoredUnlocked(projectId, path))
  }

  private async readStoredUnlocked(
    projectId: string,
    path: string
  ): Promise<readonly SceneGenerationExecution[]> {
    return readCurrentExecutionRecordFile({
      stateRoot: this.stateRoot,
      projectId,
      relativePath: this.relativePath(projectId),
      documentPath: path
    })
  }

  private async writeStored(
    projectId: string,
    operations: readonly SceneGenerationExecution[]
  ): Promise<void> {
    await writeJsonDocument(
      await this.projectPath(projectId),
      {
        version: SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION,
        executions: operations.map((execution) => executionDocumentSchema.parse(execution))
      },
      failure
    )
  }

  private requireThreadScene(
    operations: readonly SceneGenerationExecution[],
    sceneId: string
  ): void {
    if (operations.some((item) => item.sceneId !== sceneId))
      throw new AppException({ code: ErrorCodes.forbidden, msg: '线程不属于当前场景' })
  }

  private async projectPath(projectId: string): Promise<string> {
    return resolveStatePath(await ensureStateRoot(this.stateRoot), this.relativePath(projectId))
  }

  private relativePath(projectId: string): string {
    return `scene-generation/projects/${assertWorkflowSegment(projectId, 'projectId')}/executions.json`
  }
}
