import {
  ensureStateRoot,
  resolveStatePath
} from '@infrastructure/workflow/checkpoints/checkpointPath'
import { z } from 'zod'
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
import { readJsonDocument, writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import {
  executionDocumentSchema,
  legacyOperationFactSchema,
  migrateExecutionDocument,
  SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION,
  type LegacyOperationFact
} from './SceneGenerationExecutionDocument'

const envelopeSchema = z.object({
  version: z.number(),
  executions: z.array(z.unknown())
})
const failure = { code: ErrorCodes.internalError, msg: '场景生成执行记录读写失败' }

type StoredOperation =
  | { kind: 'current'; execution: SceneGenerationExecution }
  | { kind: 'legacy'; fact: LegacyOperationFact; raw: unknown; migrated?: SceneGenerationExecution }

export class FileSceneGenerationExecutionRepositoryImpl
  implements SceneGenerationExecutionRepository, SceneGenerationSceneHistoryReader
{
  constructor(private readonly stateRoot: string) {}

  /** 按工程与操作读取，拒绝跨场景归属。 */
  async readExecution(scope: SceneGenerationScopeDTO): Promise<SceneGenerationExecution | null> {
    assertWorkflowSegment(scope.operationId, 'operationId')
    const result = (await this.readStored(scope.projectId)).find(
      (item) => operationFact(item).operationId === scope.operationId
    )
    if (!result) return null
    if (operationFact(result).sceneId !== scope.sceneId)
      throw new AppException({ code: ErrorCodes.forbidden, msg: '操作不属于当前场景' })
    if (result.kind === 'legacy')
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '旧格式执行记录已保留，但不能恢复其缺失的记录时间'
      })
    return result.execution
  }

  async findActiveExecution(
    scope: SceneGenerationThreadDTO
  ): Promise<SceneGenerationExecution | null> {
    const operations = (await this.readStored(scope.projectId)).filter(
      (item) => operationFact(item).threadId === scope.threadId
    )
    this.requireThreadScene(operations, scope.sceneId)
    const current = operations.find(
      (item) => item.kind === 'current' && !isTerminal(item.execution)
    )
    if (current?.kind === 'current') return current.execution
    if (operations.some((item) => item.kind === 'legacy' && !isTerminalState(item.fact.state)))
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该创作对话仍有未结束的旧格式操作'
      })
    return null
  }

  /** 单次原子替换同时建立操作和线程登记，多实例共用文件串行边界。 */
  async createExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution> {
    const path = await this.projectPath(execution.projectId)
    return withFileTurn(path, async () => {
      const operations = await this.readStored(execution.projectId)
      if (
        operations.some(
          (item) =>
            operationFact(item).operationId === execution.operationId ||
            (operationFact(item).threadId === execution.threadId && !isStoredTerminal(item))
        )
      )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '操作已存在或线程仍有未结束操作'
        })
      if (
        operations.some(
          (item) =>
            (operationFact(item).threadId === execution.threadId &&
              operationFact(item).sceneId !== execution.sceneId) ||
            (operationFact(item).branchId === execution.branchId &&
              operationFact(item).threadId !== execution.threadId)
        )
      )
        throw new AppException({ code: ErrorCodes.forbidden, msg: '线程或分支归属不匹配' })
      // 并发启动以仓储原子块为准：同场景已存在进行中的生成时，新的生成一律拒绝。
      // 分叉、修复等模式没有 generate 标记，不占用场景生成位置。
      if (
        execution.mode === 'generate' &&
        operations.some(
          (item) =>
            operationFact(item).sceneId === execution.sceneId &&
            isActiveGenerationExecution({
              mode: item.kind === 'current' ? item.execution.mode : undefined,
              state: operationFact(item).state
            })
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
      await this.writeStored(execution.projectId, [
        ...operations,
        { kind: 'current', execution: recorded }
      ])
      return recorded
    })
  }

  /** 保存已接受回复及执行事实，不改变操作身份。 */
  async writeExecution(execution: SceneGenerationExecution): Promise<SceneGenerationExecution> {
    return withFileTurn(await this.projectPath(execution.projectId), async () => {
      const operations = await this.readStored(execution.projectId)
      const index = operations.findIndex(
        (item) => operationFact(item).operationId === execution.operationId
      )
      const previous = operations[index]
      if (!previous || previous.kind === 'legacy')
        throw new AppException({
          code: ErrorCodes.forbidden,
          msg: previous ? '旧格式执行记录已保留，不能按当前输入覆盖' : '执行记录归属不匹配'
        })
      const fact = previous.execution
      if (
        fact.sceneId !== execution.sceneId ||
        fact.threadId !== execution.threadId ||
        fact.branchId !== execution.branchId ||
        fact.fingerprint !== execution.fingerprint
      )
        throw new AppException({ code: ErrorCodes.forbidden, msg: '执行记录归属不匹配' })
      const now = new Date().toISOString()
      const recorded: SceneGenerationExecution = {
        ...execution,
        createdAt: fact.createdAt ?? execution.createdAt ?? now,
        updatedAt: now
      }
      operations[index] = { kind: 'current', execution: recorded }
      await this.writeStored(execution.projectId, operations)
      return recorded
    })
  }

  /** 基础设施内历史与清理取得同线程归属，不暴露额外应用端口。 */
  async listThread(scope: SceneGenerationThreadDTO): Promise<SceneGenerationExecution[]> {
    assertWorkflowSegment(scope.threadId, 'threadId')
    const operations = (await this.readStored(scope.projectId)).filter(
      (item) => operationFact(item).threadId === scope.threadId
    )
    this.requireThreadScene(operations, scope.sceneId)
    if (operations.some((item) => item.kind === 'legacy' && !isTerminalState(item.fact.state)))
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该创作对话仍有未结束的旧格式操作'
      })
    return operations.flatMap((item) => (item.kind === 'current' ? [item.execution] : []))
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
    return (await this.readStored(projectId)).flatMap((item) =>
      item.kind === 'current' &&
      item.execution.sceneId === sceneId &&
      (item.execution.updatedAt ?? item.execution.timeline?.at(-1)?.createdAt)
        ? [item.execution]
        : item.kind === 'legacy' &&
            item.fact.sceneId === sceneId &&
            item.migrated &&
            (item.migrated.updatedAt ?? item.migrated.timeline?.at(-1)?.createdAt)
          ? [item.migrated]
          : []
    )
  }

  /** 解析版本 1 到当前版本（含已废弃的版本 6）。旧输入快照保留原文，不让一条旧记录阻断同工程的其他操作。 */
  private async readStored(projectId: string): Promise<StoredOperation[]> {
    const value = await readJsonDocument(await this.projectPath(projectId), failure)
    if (value === null) return []
    const envelope = envelopeSchema.safeParse(value)
    if (
      !envelope.success ||
      (envelope.data.version !== 1 &&
        envelope.data.version !== 2 &&
        envelope.data.version !== 3 &&
        envelope.data.version !== 4 &&
        envelope.data.version !== 5 &&
        envelope.data.version !== 6 &&
        envelope.data.version !== SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION)
    )
      throw new AppException({ ...failure, cause: envelope.success ? undefined : envelope.error })
    return envelope.data.executions.map((item) => this.readStoredItem(projectId, item))
  }

  /** 当前输入能解析则继续；有记录时间的旧格式先迁移，没有时间事实的只保留原文。 */
  private readStoredItem(projectId: string, item: unknown): StoredOperation {
    const current = executionDocumentSchema.safeParse(migrateExecutionDocument(item))
    if (current.success) {
      if (current.data.projectId !== projectId)
        throw new AppException({ ...failure, msg: '场景生成执行记录不属于当前工程' })
      return { kind: 'current', execution: current.data }
    }
    const legacy = legacyOperationFactSchema.safeParse(item)
    if (!legacy.success || legacy.data.projectId !== projectId)
      throw new AppException({ ...failure, cause: legacy.success ? undefined : legacy.error })
    return { kind: 'legacy', fact: legacy.data, raw: item }
  }

  /** 写回时升到当前版本，旧记录原样保留。 */
  private async writeStored(
    projectId: string,
    operations: readonly StoredOperation[]
  ): Promise<void> {
    await writeJsonDocument(
      await this.projectPath(projectId),
      {
        version: SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION,
        executions: operations.map((item) =>
          item.kind === 'current' ? executionDocumentSchema.parse(item.execution) : item.raw
        )
      },
      failure
    )
  }

  private requireThreadScene(operations: readonly StoredOperation[], sceneId: string): void {
    if (operations.some((item) => operationFact(item).sceneId !== sceneId))
      throw new AppException({ code: ErrorCodes.forbidden, msg: '线程不属于当前场景' })
  }

  /** 校验身份后推导固定本机位置。 */
  private async projectPath(projectId: string): Promise<string> {
    return resolveStatePath(
      await ensureStateRoot(this.stateRoot),
      `scene-generation/projects/${assertWorkflowSegment(projectId, 'projectId')}/executions.json`
    )
  }
}

function operationFact(item: StoredOperation): LegacyOperationFact {
  if (item.kind === 'legacy') return item.fact
  return {
    projectId: item.execution.projectId,
    sceneId: item.execution.sceneId,
    operationId: item.execution.operationId,
    threadId: item.execution.threadId,
    branchId: item.execution.branchId,
    fingerprint: item.execution.fingerprint,
    state: item.execution.state
  }
}

function isStoredTerminal(item: StoredOperation): boolean {
  return isTerminalState(operationFact(item).state)
}

function isTerminalState(state: LegacyOperationFact['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}
