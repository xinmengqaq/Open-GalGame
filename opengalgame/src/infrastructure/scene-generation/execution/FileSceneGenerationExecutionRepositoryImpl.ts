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
import { withFileTurn } from '@infrastructure/ai/tools/WorkspaceFileTools'
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

  /** 按工程与操作读取，拒绝跨场景归属。 */
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

  /** 单次原子替换同时建立操作和线程登记，多实例共用文件串行边界。 */
  async createExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution> {
    const path = await this.projectPath(execution.projectId)
    return withFileTurn(path, async () => {
      const operations = await this.readStoredUnlocked(execution.projectId, path)
      if (
        operations.some(
          (item) =>
            item.operationId === execution.operationId ||
            (item.threadId === execution.threadId && !isTerminal(item))
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
      // 并发启动以仓储原子块为准：同场景已存在进行中的生成时，新的生成一律拒绝。
      // 分叉、修复等模式没有 generate 标记，不占用场景生成位置；当前记录可缺省 mode。
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

  /** 保存已接受回复及执行事实，不改变操作身份。 */
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

  /** 基础设施内历史与清理取得同线程归属，不暴露额外应用端口。 */
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

  /**
   * 复用场景内的历史读取范围，不按历史页大小截断，避免最新操作因分页丢失。
   * updatedAt 并列时用 createdAt 和存储顺序兜底，保证同一份文件每次选出同一条。
   */
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

  /**
   * 读取在文件串行边界内完成：首访旧格式先备份原始字节、当前化可迁移记录、
   * 把只能归档的旧记录移出产品文件，再返回当前记录；迁移未完成则明确拒绝。
   */
  private async readStored(projectId: string): Promise<readonly SceneGenerationExecution[]> {
    const path = await this.projectPath(projectId)
    return withFileTurn(path, () => this.readStoredUnlocked(projectId, path))
  }

  /** 假定调用方已持有同一文件的串行边界，禁止在这里再次进入 withFileTurn。 */
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

  /** 写回当前版本；调用前已在同一串行边界内确认记录全部当前化。 */
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

  /** 校验身份后推导固定本机位置。 */
  private async projectPath(projectId: string): Promise<string> {
    return resolveStatePath(await ensureStateRoot(this.stateRoot), this.relativePath(projectId))
  }

  private relativePath(projectId: string): string {
    return `scene-generation/projects/${assertWorkflowSegment(projectId, 'projectId')}/executions.json`
  }
}
