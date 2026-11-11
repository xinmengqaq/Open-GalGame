import type { SceneVersionGateway } from '@application/scene-generation/ports/SceneVersionGateway'
import type {
  SceneGenerationBaseline,
  SceneGenerationCandidate,
  SceneGenerationCommitState,
  SceneGenerationExecution,
  SceneGenerationVersionFacts
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { ProjectApplicationService } from '@application/projects/services/ProjectApplicationService'
import type { ProjectWorkspaceVO } from '@application/projects/vo/ProjectWorkspaceVO'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { SceneGenerationVersionConflict } from '@application/scene-generation/policies/SceneGenerationVersionConflict'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { readSceneLock } from '@infrastructure/scenes/sceneLockReader'

const SOURCE_MODULE = 'scene-generation'

/**
 * 经版本应用服务发布场景候选。
 * 生成仍决定锁定、候选来源和何时提交。
 * 场景执行自己的 operationId 不是版本身份，不能用来核对这次提交。
 * 候选引用只携带来源身份和已发布修订，不把工作区路径当成内容。
 */
export class SceneVersionGatewayImpl implements SceneVersionGateway {
  constructor(
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly projects: Pick<ProjectApplicationService, 'ensureProjectWorkspace'>
  ) {}

  /** 读取正式场景修订及锁定事实。仓库缺失时由版本服务拒绝，不在这里建库。 */
  async readBaseline(source: SceneSourceLocation): Promise<SceneGenerationBaseline> {
    const relativePath = `${source.sceneDirectory}/${source.entryFile}`
    let baseline
    try {
      baseline = await this.versioning.readWorkBaseline(source.projectId)
    } catch (error) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '作品基线记录无法读取',
        cause: error
      })
    }
    if (!baseline) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '作品基线记录无法读取'
      })
    }
    return {
      commitId: baseline.revisionRef,
      affectedFiles: [{ relativePath, digest: baseline.baselineRef }],
      lockState: await readSceneLock(source)
    }
  }

  /** 启动前核对工程工作区。查询基线仍只读，不在这里建库。 */
  ensureWorkspace(projectId: string): Promise<ProjectWorkspaceVO> {
    return this.projects.ensureProjectWorkspace({ projectId })
  }

  /** 比较当前作品修订和本操作基线，锁定始终读取正式文件。 */
  async inspectBaseline(execution: SceneGenerationExecution): Promise<SceneGenerationVersionFacts> {
    const current = await this.readBaseline(execution.source)
    return {
      baselineState: sameBaseline(execution.baseline, current) ? 'unchanged' : 'changed',
      lockState: current.lockState
    }
  }

  /**
   * 在短提交边界内重新核对锁定和基线。
   * 候选引用不能固定时失败，不把工作区路径或快照标识当成已保留内容。
   */
  async commitCandidate(
    execution: SceneGenerationExecution,
    candidate: SceneGenerationCandidate,
    requireVersion: (facts: SceneGenerationVersionFacts) => void
  ): Promise<{ commitId: string }> {
    if (candidate.assetChanges.length) {
      throw new AppException({
        code: ErrorCodes.forbidden,
        msg: '本次仅授权已有素材和目标脚本，不允许素材变更'
      })
    }
    const paths = execution.baseline.affectedFiles.map((file) => file.relativePath)
    const current = await this.readBaseline(execution.source)
    if (!sameBaseline(execution.baseline, current)) {
      throw new SceneGenerationVersionConflict('作品基线已变化，不能覆盖')
    }
    await requireVersion({ baselineState: 'unchanged', lockState: current.lockState })
    const targets = [{ kind: 'scene', id: execution.source.sceneId }]
    const existing = await this.versioning.readCallerOperation({
      projectId: execution.source.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: execution.operationId
    })
    const prepared = existing
      ? await this.versioning.readPreparedOperation({
          projectId: execution.source.projectId,
          operationId: existing.operationId
        })
      : await this.versioning.prepareOperation({
          projectId: execution.source.projectId,
          sourceModule: SOURCE_MODULE,
          targets,
          changePaths: paths,
          watchedPaths: []
        })
    await this.versioning.bindCallerOperation({
      projectId: execution.source.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: execution.operationId,
      operationId: prepared.operationId,
      targets,
      changePaths: paths,
      watchedPaths: []
    })
    if (!existing && prepared.revisionRef !== execution.baseline.commitId) {
      throw new SceneGenerationVersionConflict('作品基线已变化，不能覆盖')
    }
    try {
      const committed = await this.versioning.commitOperation(
        {
          projectId: execution.source.projectId,
          operationId: prepared.operationId,
          baselineRef: prepared.baselineRef,
          input: {
            kind: 'candidate',
            candidateRef: [
              SOURCE_MODULE,
              execution.projectId,
              execution.threadId,
              execution.operationId,
              candidate.candidateSnapshotId
            ].join('\0'),
            changes: paths.map((relativePath) => ({ relativePath, action: 'modify' as const }))
          },
          saveMode: 'manual',
          contentSource: 'ai',
          title: '确认场景生成',
          summary: '已确认的场景脚本进入作品'
        },
        async () => requireVersion(await this.inspectBaseline(execution))
      )
      return { commitId: committed.revisionRef }
    } catch (error) {
      if (error instanceof SceneGenerationVersionConflict) throw error
      if (
        error instanceof AppException &&
        (error.code === ProjectVersioningErrorCodes.invalidContentFingerprint ||
          error.code === ProjectVersioningErrorCodes.contentFingerprintConflict)
      ) {
        throw error
      }
      try {
        requireVersion(await this.inspectBaseline(execution))
      } catch (conflict) {
        if (conflict instanceof SceneGenerationVersionConflict) {
          throw new SceneGenerationVersionConflict(
            conflict.message,
            new AggregateError([error, conflict], '提交失败与版本冲突')
          )
        }
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '提交失败且版本复核未完成',
          cause: new AggregateError([error, conflict])
        })
      }
      if (error instanceof AppException && error.code === ErrorCodes.operationConflict) throw error
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '场景提交结果不明确',
        cause: error
      })
    }
  }

  /**
   * 只读核对当前执行。
   * 没有持久关联表示尚未提交；证据矛盾时保持不明，不把其他操作当成这次提交。
   */
  async readOperationCommit(
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationCommitState> {
    const link = await this.callerLink(execution)
    if (!link) return { state: 'notCommitted' }
    const settlement = await this.versioning.readOperationSettlement({
      projectId: execution.source.projectId,
      operationId: link.operationId
    })
    if (settlement.state === '待核对') return { state: 'unknown' }
    return toCommitState(settlement)
  }

  /** 只回退本操作记录的明确修改。调用方身份对不上时拒绝，不扩大路径。 */
  async rollbackCandidate(
    execution: SceneGenerationExecution,
    commitId: string
  ): Promise<{ rollbackCommitId: string }> {
    const link = await this.callerLink(execution)
    if (!link) {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '回退提交不属于当前操作' })
    }
    const settlement = await this.versioning.readOperationSettlement({
      projectId: execution.source.projectId,
      operationId: link.operationId
    })
    if (settlement.state === '已回退') return { rollbackCommitId: settlement.revisionRef }
    if (
      (settlement.state !== '待回退' && settlement.state !== '已提交') ||
      settlement.revisionRef !== commitId
    ) {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '回退提交不属于当前操作' })
    }
    const rolled = await this.versioning.rollbackOperation({
      projectId: execution.source.projectId,
      operationId: link.operationId
    })
    return { rollbackCommitId: rolled.revisionRef }
  }

  private async callerLink(
    execution: SceneGenerationExecution
  ): Promise<{ operationId: string } | null> {
    const link = await this.versioning.readCallerOperation({
      projectId: execution.source.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: execution.operationId
    })
    if (!link || link.projectId !== execution.source.projectId) return null
    return link
  }
}

function toCommitState(settlement: VersionSettlementVO): SceneGenerationCommitState {
  if (settlement.state === '已提交' || settlement.state === '无变更') {
    return { state: 'committed', commitId: settlement.revisionRef }
  }
  if (settlement.state === '待回退') {
    return { state: 'rollbackRequired', commitId: settlement.revisionRef }
  }
  if (settlement.state === '未提交') return { state: 'notCommitted' }
  return { state: 'unknown' }
}

function sameBaseline(expected: SceneGenerationBaseline, actual: SceneGenerationBaseline): boolean {
  return (
    expected.commitId === actual.commitId &&
    expected.affectedFiles.length === actual.affectedFiles.length &&
    expected.affectedFiles.every(
      (file) =>
        actual.affectedFiles.find((item) => item.relativePath === file.relativePath)?.digest ===
        file.digest
    )
  )
}
