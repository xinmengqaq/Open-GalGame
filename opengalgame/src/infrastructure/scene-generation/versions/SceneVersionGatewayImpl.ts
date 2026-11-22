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
import type { VersionScopeBaselineDTO } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import type { SceneBaselineState } from '@domain/scene-generation/models/SceneGenerationRequest'
import type { WorkPathState } from '@infrastructure/git/GitRepository'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { SceneGenerationVersionConflict } from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { digestBytes } from '@infrastructure/git/objects/gitContent'
import { readCommitFile } from '@infrastructure/git/objects/gitTree'
import { readWorkBaseline } from '@infrastructure/git/repository/WorkBaseline'
import { readSceneLock } from '@infrastructure/scenes/sceneLockReader'

const SOURCE_MODULE = 'scene-generation'
const ABSENT_DIGEST = 'absent'
const REVISION_DIGEST_PATTERN = /^[0-9a-f]{40}$/u
const SCOPE_DIGEST_PATTERN = /^worktree=([0-9a-f]{64}|absent);stage=([0-9a-f]{64}|absent)$/u
const COMMIT_ATTEMPTS = 2

export class SceneVersionGatewayImpl implements SceneVersionGateway {
  constructor(
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly projects: Pick<ProjectApplicationService, 'ensureProjectWorkspace'>
  ) {}

  async readBaseline(source: SceneSourceLocation): Promise<SceneGenerationBaseline> {
    const relativePath = `${source.sceneDirectory}/${source.entryFile}`
    await this.requireVersionBaseline(source.projectId)
    const scope = await readSceneScope(source, relativePath)
    return {
      commitId: scope.headCommitId,
      affectedFiles: [{ relativePath, digest: encodeScopeDigest(scope) }],
      lockState: await readSceneLock(source)
    }
  }

  ensureWorkspace(projectId: string): Promise<ProjectWorkspaceVO> {
    return this.projects.ensureProjectWorkspace({ projectId })
  }

  async inspectBaseline(execution: SceneGenerationExecution): Promise<SceneGenerationVersionFacts> {
    const current = await this.readBaseline(execution.source)
    return {
      baselineState: await this.compareBaseline(execution, current),
      lockState: current.lockState
    }
  }

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
    if (!paths.length) throw new SceneGenerationVersionConflict('候选缺少可核对的写入范围')
    const scopeBaseline = await this.candidateBaseScope(execution)
    const initial = await this.inspectBaseline(execution)
    if (initial.baselineState !== 'unchanged') {
      throw new SceneGenerationVersionConflict('目标场景已变化，不能覆盖')
    }
    requireVersion(initial)
    const targets = [{ kind: 'scene', id: execution.source.sceneId }]
    const existing = await this.versioning.readCallerOperation({
      projectId: execution.source.projectId,
      sourceModule: SOURCE_MODULE,
      callerOperationId: execution.operationId
    })
    if (existing) {
      const settlement = await this.versioning.readOperationSettlement({
        projectId: execution.source.projectId,
        operationId: existing.operationId
      })
      if (settlement.state === '已回退' || settlement.state === '待回退') {
        throw new SceneGenerationVersionConflict('本次操作已回退，不能再次提交')
      }
    }
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
    let attempt = 0
    for (;;) {
      try {
        return await this.commitCandidateOnce(
          execution,
          candidate,
          paths,
          prepared,
          scopeBaseline,
          requireVersion
        )
      } catch (error) {
        if (!isRetriableMergeRace(error)) throw error
        if (attempt >= COMMIT_ATTEMPTS - 1) {
          throw new SceneGenerationVersionConflict('目标场景或候选写入冲突，不能覆盖', error)
        }
        attempt += 1
        const current = await this.inspectBaseline(execution)
        if (current.baselineState !== 'unchanged') {
          throw new SceneGenerationVersionConflict('目标场景已变化，不能覆盖', error)
        }
        requireVersion(current)
      }
    }
  }

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

  private async commitCandidateOnce(
    execution: SceneGenerationExecution,
    candidate: SceneGenerationCandidate,
    paths: readonly string[],
    prepared: { operationId: string; baselineRef: string },
    scopeBaseline: VersionScopeBaselineDTO,
    requireVersion: (facts: SceneGenerationVersionFacts) => void
  ): Promise<{ commitId: string }> {
    try {
      const committed = await this.versioning.commitOperation(
        {
          projectId: execution.source.projectId,
          operationId: prepared.operationId,
          callerOperationId: execution.operationId,
          baselineRef: prepared.baselineRef,
          scopeBaseline,
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
        async () => {
          const boundary = await this.inspectBaseline(execution)
          if (boundary.baselineState !== 'unchanged') {
            throw new SceneGenerationVersionConflict('目标场景已变化，不能覆盖')
          }
          requireVersion(boundary)
        }
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
        const current = await this.inspectBaseline(execution)
        if (current.baselineState !== 'unchanged') {
          throw new SceneGenerationVersionConflict('目标场景已变化，不能覆盖')
        }
        requireVersion(current)
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

  private async requireVersionBaseline(projectId: string): Promise<void> {
    let baseline
    try {
      baseline = await this.versioning.readWorkBaseline(projectId)
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
  }

  private async compareBaseline(
    execution: SceneGenerationExecution,
    current: SceneGenerationBaseline
  ): Promise<SceneBaselineState> {
    const expected = execution.baseline
    if (!expected.affectedFiles.length) {
      return expected.commitId === current.commitId ? 'unchanged' : 'changed'
    }
    if (expected.affectedFiles.length !== current.affectedFiles.length) return 'changed'
    let unresolved = false
    for (const file of expected.affectedFiles) {
      const actual = current.affectedFiles.find((item) => item.relativePath === file.relativePath)
      const actualScope = decodeScopeDigest(actual?.digest)
      if (!actualScope) return 'changed'
      if (decodeScopeDigest(file.digest)) {
        if (file.digest !== actual?.digest) return 'changed'
        continue
      }
      if (!REVISION_DIGEST_PATTERN.test(file.digest ?? '')) {
        return expected.commitId === current.commitId ? 'unchanged' : 'changed'
      }
      if (file.digest !== expected.commitId) return 'unknown'
      let historical: Uint8Array | null
      try {
        historical = await readCommitFile(
          { dir: execution.source.projectRoot },
          expected.commitId,
          file.relativePath
        )
      } catch {
        unresolved = true
        continue
      }
      if (actualScope.worktree !== (historical ? digestBytes(historical) : null)) return 'changed'
    }
    return unresolved ? 'unknown' : 'unchanged'
  }

  private async candidateBaseScope(
    execution: SceneGenerationExecution
  ): Promise<VersionScopeBaselineDTO> {
    if (!REVISION_DIGEST_PATTERN.test(execution.baseline.commitId)) {
      throw new SceneGenerationVersionConflict('候选生成时修订无法核对，不能覆盖')
    }
    const paths: Array<{ relativePath: string; worktree: string | null; stage: string | null }> = []
    for (const file of execution.baseline.affectedFiles) {
      const scope = decodeScopeDigest(file.digest)
      if (scope) {
        paths.push({ relativePath: file.relativePath, ...scope })
        continue
      }
      if (
        !REVISION_DIGEST_PATTERN.test(file.digest ?? '') ||
        file.digest !== execution.baseline.commitId
      ) {
        throw new SceneGenerationVersionConflict('候选基点无法核对，不能覆盖')
      }
      let historical: Uint8Array | null
      try {
        historical = await readCommitFile(
          { dir: execution.source.projectRoot },
          execution.baseline.commitId,
          file.relativePath
        )
      } catch (error) {
        throw new SceneGenerationVersionConflict('候选基点无法核对，不能覆盖', error)
      }
      const digest = historical ? digestBytes(historical) : null
      paths.push({ relativePath: file.relativePath, worktree: digest, stage: digest })
    }
    if (!paths.length) throw new SceneGenerationVersionConflict('候选缺少可核对的写入范围')
    return { revisionRef: execution.baseline.commitId, paths }
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

async function readSceneScope(
  source: SceneSourceLocation,
  relativePath: string
): Promise<WorkPathState & { headCommitId: string }> {
  try {
    const baseline = await readWorkBaseline(source.projectRoot, [relativePath])
    const path = baseline.paths[0]
    if (!path) {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '目标场景内容无法读取'
      })
    }
    return { ...path, headCommitId: baseline.headCommitId }
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new AppException({
      code: SceneGenerationErrorCodes.gitQueryFailed,
      msg: '目标场景内容无法读取',
      cause: error
    })
  }
}

function encodeScopeDigest(state: WorkPathState): string {
  return `worktree=${state.worktree.digest ?? ABSENT_DIGEST};stage=${state.stage.digest ?? ABSENT_DIGEST}`
}

function decodeScopeDigest(digest: string | undefined): {
  worktree: string | null
  stage: string | null
} | null {
  if (digest === undefined) return null
  const match = SCOPE_DIGEST_PATTERN.exec(digest)
  if (!match) return null
  return {
    worktree: match[1] === ABSENT_DIGEST ? null : (match[1] ?? null),
    stage: match[2] === ABSENT_DIGEST ? null : (match[2] ?? null)
  }
}

function isRetriableMergeRace(error: unknown): boolean {
  return (
    error instanceof AppException &&
    error.code === ErrorCodes.operationConflict &&
    !(error instanceof SceneGenerationVersionConflict)
  )
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
