import { createHash } from 'node:crypto'

import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import type { VersionTransactionFact } from '@domain/project-versioning/models/VersionTransactionFact'
import { requireOperationId } from '@domain/project-versioning/services/versionProtocolGuards'

import { bindPreparedOperation } from '@domain/project-versioning/services/bindPreparedOperation'
import { resolveCommitTransition } from '@domain/project-versioning/services/resolveCommitTransition'
import { resolveRollbackTransition } from '@domain/project-versioning/services/resolveRollbackTransition'
import { resolveVersionSettlement } from '@domain/project-versioning/services/resolveVersionSettlement'
import type {
  BindCallerVersionOperationDTO,
  ClearVersionHistoryDTO,
  CommitVersionOperationDTO,
  FileChangesInputDTO,
  FindCallerVersionOperationDTO,
  ImmutableCandidateInputDTO,
  InitializeWorkBaselineDTO,
  ListVersionHistoryDTO,
  PrepareVersionOperationDTO,
  PruneVersionRecordsDTO,
  ReadCallerVersionOperationDTO,
  ReadVersionOperationDTO,
  RollbackVersionOperationDTO,
  UndoVersionHistoryDTO,
  VersionContentSource,
  VersionFileChange,
  VersionSaveMode
} from '../../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../../models/VersionTarget'
import type {
  VersionBoundRetention,
  VersionContentGateway
} from '../../ports/VersionContentGateway'
import type { VersionHistoryFact, VersionHistoryGateway } from '../../ports/VersionHistoryGateway'
import type {
  VersionCommitIntent,
  VersionOperationRecord,
  VersionOperationRecordGateway
} from '../../ports/VersionOperationRecordGateway'
import type {
  VersionCommitExecution,
  VersionRollbackExecution,
  VersionTransactionGateway,
  VersionTransactionView
} from '../../ports/VersionTransactionGateway'
import type { ProjectVersioningApplicationService } from '../ProjectVersioningApplicationService'
import type {
  CallerVersionOperationVO,
  PreparedVersionOperationVO,
  VersionCommitVO,
  VersionRollbackVO,
  VersionSettlementVO,
  WorkBaselineVO
} from '../../vo/ProjectVersioningVO'
import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '../../vo/VersionHistoryVO'

const SYSTEM_HISTORY_KEEP = 100
const SCOPE_FINGERPRINT = 'scope'
const CHANGED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u

/** 应用服务的端口依赖。身份生成由启动装配注入。 */
export interface ProjectVersioningApplicationDependencies {
  readonly transactions: VersionTransactionGateway
  readonly records: VersionOperationRecordGateway
  readonly content: VersionContentGateway
  readonly history: VersionHistoryGateway
  readonly nextId: () => string
}

/**
 * 编排基线、提交、结算、回退和用户历史。
 * 只依赖端口和纯领域规则，不读取作品文件，也不保存权威操作状态。
 */
export class ProjectVersioningApplicationServiceImpl implements ProjectVersioningApplicationService {
  constructor(private readonly deps: ProjectVersioningApplicationDependencies) {}

  /** @throws {AppException} 范围不合法或仓库不能建立基线。 */
  async initializeBaseline(request: InitializeWorkBaselineDTO): Promise<WorkBaselineVO> {
    requireText(request.projectId, '工程身份不正确')
    assertDeclaredPaths('baseline-scope', request.initialPaths, [])
    return this.deps.transactions.initializeBaseline({
      projectId: request.projectId,
      initialPaths: [...request.initialPaths]
    })
  }

  /** @throws {AppException} 工程身份不合法或基线无法读取。 */
  async readWorkBaseline(projectId: string): Promise<WorkBaselineVO | null> {
    requireText(projectId, '工程身份不正确')
    return this.deps.transactions.readBaseline(projectId)
  }

  /** @throws {AppException} 没有可靠基线、范围不合法或准备事实不能持久化。 */
  async prepareOperation(request: PrepareVersionOperationDTO): Promise<PreparedVersionOperationVO> {
    requireText(request.projectId, '工程身份不正确')
    requireText(request.sourceModule, '来源模块不正确')
    const targets = request.targets.map((target) => copyTarget(target))
    const operationId = this.deps.nextId()
    assertDeclaredPaths(operationId, request.changePaths, request.watchedPaths)
    const baseline = await this.deps.transactions.readBaseline(request.projectId)
    if (!baseline) {
      fail(ProjectVersioningErrorCodes.gitNoCommits, '工程还没有可靠作品基线')
    }
    await this.deps.records.bindPrepared({
      projectId: request.projectId,
      operationId,
      sourceModule: request.sourceModule,
      targets,
      changePaths: [...request.changePaths],
      watchedPaths: [...request.watchedPaths],
      baselineRef: baseline.baselineRef,
      revisionRef: baseline.revisionRef
    })
    return {
      operationId,
      baselineRef: baseline.baselineRef,
      revisionRef: baseline.revisionRef
    }
  }

  /** @throws {AppException} 调用方身份改绑工程、来源、目标或声明范围。 */
  async bindCallerOperation(request: BindCallerVersionOperationDTO): Promise<void> {
    requireText(request.projectId, '工程身份不正确')
    requireText(request.sourceModule, '来源模块不正确')
    requireOperationId(request.callerOperationId)
    requireOperationId(request.operationId)
    await this.deps.records.bindCallerOperation({
      projectId: request.projectId,
      sourceModule: request.sourceModule,
      callerOperationId: request.callerOperationId,
      operationId: request.operationId,
      targets: request.targets.map((target) => copyTarget(target)),
      changePaths: [...request.changePaths],
      watchedPaths: [...request.watchedPaths]
    })
  }

  /** 按工程读取调用方关联。没有记录时返回 null，不表示可以重提。 */

  async readCallerOperation(
    request: ReadCallerVersionOperationDTO
  ): Promise<CallerVersionOperationVO | null> {
    requireText(request.projectId, '工程身份不正确')
    requireText(request.sourceModule, '来源模块不正确')
    return this.deps.records.readCallerOperation(
      request.projectId,
      request.sourceModule,
      request.callerOperationId
    )
  }

  /** 调用方没有工程时按来源查找。多个工程归属矛盾时失败。 */

  async findCallerOperation(
    request: FindCallerVersionOperationDTO
  ): Promise<CallerVersionOperationVO | null> {
    requireText(request.sourceModule, '来源模块不正确')
    return this.deps.records.findCallerOperation(request.sourceModule, request.callerOperationId)
  }

  /** 读取已经准备好的操作。不存在或工程不符时失败，不生成新身份。 */
  async readPreparedOperation(
    request: ReadVersionOperationDTO
  ): Promise<PreparedVersionOperationVO> {
    requireText(request.projectId, '工程身份不正确')
    const record = await this.requireRecord(request.projectId, request.operationId)
    return {
      operationId: record.operationId,
      baselineRef: record.baselineRef,
      revisionRef: record.revisionRef
    }
  }

  /** @throws {AppException} 身份冲突、基线变化、前置条件拒绝、确定失败或结果不明。 */
  async commitOperation(
    request: CommitVersionOperationDTO,
    requirePreconditions: () => void | Promise<void>
  ): Promise<VersionCommitVO> {
    this.requireCommitRequest(request)
    const record = await this.requireRecord(request.projectId, request.operationId)
    if (request.baselineRef !== record.baselineRef) {
      fail(ErrorCodes.operationConflict, '作品基线与已准备操作不一致')
    }
    const fingerprint = fingerprintOf(request)
    const requestedPaths = request.input.changes.map((change) => change.relativePath)
    const snapshot = await this.readCommitSnapshot(request.projectId, request.operationId)
    this.rejectChangedIntent(record, fingerprint, requestedPaths)
    if (
      record.commitIntent &&
      snapshot &&
      record.commitIntent.contentFingerprint !== snapshot.contentFingerprint
    ) {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '提交结果不明，不能重试')
    }
    const transition = resolveCommitTransition({
      operationId: request.operationId,
      contentFingerprint: fingerprint,
      requestedPaths,
      allowedPaths: record.changePaths,
      watchedPaths: record.watchedPaths,
      fact: snapshot ? toDomainFact(snapshot) : null
    })
    if (transition.kind === 'existing') {
      if (!snapshot)
        fail(ProjectVersioningErrorCodes.insufficientEvidence, '提交结果不明，不能重试')
      const existing = toCommitVo(request.operationId, snapshot)
      await this.maintainQuietly(request.projectId)
      return existing
    }

    assertRepositoryPaths(requestedPaths)
    const retentions = await this.deps.content.retain({
      projectId: request.projectId,
      operationId: request.operationId,
      fingerprint,
      input: request.input
    })
    requireMatchingRetentions(request.input, retentions)
    const intent = this.commitIntent(record, fingerprint, request, retentions)
    await this.deps.records.bindCommitIntent(request.projectId, request.operationId, intent)

    let execution: VersionCommitExecution
    try {
      execution = await this.deps.transactions.commit({
        projectId: request.projectId,
        operationId: request.operationId,
        baselineRef: record.baselineRef,
        contentFingerprint: fingerprint,
        changes: retentions,
        verify: async (observation) => {
          if (
            observation.baseline.baselineRef !== record.baselineRef ||
            observation.baseline.revisionRef !== record.revisionRef ||
            observation.subsequentPaths.some(
              (path) => record.changePaths.includes(path) || record.watchedPaths.includes(path)
            )
          ) {
            fail(ErrorCodes.operationConflict, '作品基线或目标文件已变化，已拒绝写入')
          }
          const again = resolveCommitTransition({
            operationId: request.operationId,
            contentFingerprint: fingerprint,
            requestedPaths: retentions.map((change) => change.relativePath),
            allowedPaths: record.changePaths,
            watchedPaths: record.watchedPaths,
            fact: observation.transaction ? toDomainFact(observation.transaction) : null
          })
          if (again.kind === 'existing') return { action: 'reuse' }
          await requirePreconditions()
          return { action: 'publish' }
        }
      })
    } catch (error) {
      const recovered = await this.recoverCommit(
        request.projectId,
        request.operationId,
        fingerprint,
        error
      )
      if (!recovered) throw error
      await this.maintainQuietly(request.projectId)
      return recovered
    }
    if (execution.state === '待核对') {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '提交结果不明，不能重试')
    }
    await this.maintainQuietly(request.projectId)
    return {
      operationId: request.operationId,
      state: execution.state,
      revisionRef: execution.revisionRef
    }
  }

  /** @throws {AppException} 操作身份不合法或结算证据无法读取。 */
  async readOperationSettlement(request: ReadVersionOperationDTO): Promise<VersionSettlementVO> {
    requireText(request.projectId, '工程身份不正确')
    resolveVersionSettlement(null, request.operationId)
    const record = await this.deps.records.read(request.projectId, request.operationId)
    let snapshot: VersionTransactionView | null
    try {
      snapshot = await this.deps.transactions.readTransaction(
        request.projectId,
        request.operationId
      )
    } catch (error) {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '操作结果暂时无法核对', error)
    }
    if (snapshot && snapshot.operationId !== request.operationId) {
      fail(ProjectVersioningErrorCodes.operationOwnershipMismatch, '操作不属于当前工程')
    }
    return toSettlement(
      request.operationId,
      snapshot,
      record?.commitIntent?.contentFingerprint ?? null
    )
  }

  /** @throws {AppException} 证据不足、后续修改冲突、确定失败或回退结果不明。 */
  async rollbackOperation(request: RollbackVersionOperationDTO): Promise<VersionRollbackVO> {
    requireText(request.projectId, '工程身份不正确')
    const record = await this.requireRecord(request.projectId, request.operationId)
    const snapshot = await this.readRollbackSnapshot(request.projectId, request.operationId)
    const transition = resolveRollbackTransition({
      operationId: request.operationId,
      requestedPaths: record.changePaths,
      ownedPaths: record.changePaths,
      fact: toRollbackFact(snapshot)
    })
    if (transition.kind === 'existing') {
      const existing = rollbackVo(request.operationId, snapshot)
      await this.maintainQuietly(request.projectId)
      return existing
    }

    let execution: VersionRollbackExecution
    try {
      execution = await this.deps.transactions.rollback({
        projectId: request.projectId,
        operationId: request.operationId,
        ownedPaths: [...record.changePaths],
        verify: async (observation) => {
          if (observation.subsequentPaths.length > 0) {
            fail(ErrorCodes.operationConflict, '目标路径已有后续修改，已拒绝回退')
          }
          const again = resolveRollbackTransition({
            operationId: request.operationId,
            requestedPaths: record.changePaths,
            ownedPaths: record.changePaths,
            fact: toRollbackFact(observation.transaction)
          })
          if (again.kind === 'existing') return { action: 'reuse' }
          return { action: 'publish' }
        }
      })
    } catch (error) {
      const recovered = await this.recoverRollback(request.projectId, request.operationId, error)
      if (!recovered) throw error
      await this.maintainQuietly(request.projectId)
      return recovered
    }
    if (execution.state === '待核对') {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '回退结果不明，不能再次回退')
    }
    await this.maintainQuietly(request.projectId)
    return {
      operationId: request.operationId,
      state: '已回退',
      revisionRef: execution.revisionRef
    }
  }

  /** @throws {AppException} 筛选不合法，或历史投影不能修复。 */
  async listHistory(request: ListVersionHistoryDTO): Promise<VersionHistoryPageVO> {
    requireText(request.projectId, '工程身份不正确')
    if (!Number.isInteger(request.pageSize) || request.pageSize < 1) {
      fail(ErrorCodes.invalidRequest, '历史分页不正确')
    }
    if (request.cursor !== undefined) requireText(request.cursor, '历史游标不正确')
    if (request.sourceModule !== undefined) requireText(request.sourceModule, '来源模块不正确')
    if (request.target !== undefined) copyTarget(request.target)
    if (request.saveMode !== undefined) requireSaveMode(request.saveMode)
    if (request.contentSource !== undefined) requireContentSource(request.contentSource)
    const entries = await this.loadHistory(request.projectId)
    return pageHistory(
      entries.filter((entry) => matchesQuery(entry, request)),
      request
    )
  }

  /** @throws {AppException} 历史不存在、已清理，或对应回退不能完成。 */
  async undoHistoryEntry(request: UndoVersionHistoryDTO): Promise<VersionHistoryUndoVO> {
    requireText(request.projectId, '工程身份不正确')
    requireText(request.historyId, '历史条目不正确')
    await this.loadHistory(request.projectId)
    const binding = await this.deps.history.resolveActive(request.projectId, request.historyId)
    if (!binding) fail(ErrorCodes.invalidRequest, '历史条目不存在或已清理')
    await this.rollbackOperation({
      projectId: request.projectId,
      operationId: binding.operationId
    })
    return { historyId: request.historyId, state: '已回退' }
  }

  /** @throws {AppException} 边界不属于工程，或清理决定不能持久化。 */
  async clearHistory(request: ClearVersionHistoryDTO): Promise<VersionHistoryClearVO> {
    requireText(request.projectId, '工程身份不正确')
    const entries = await this.loadHistory(request.projectId)
    const selected = selectHistory(entries, request.selection)
    if (selected.length === 0) return { clearedCount: 0 }
    await this.deps.history.persistClearMarkers(
      request.projectId,
      selected.map((entry) => entry.historyId)
    )
    const remaining = await this.rebuildHistory(
      request.projectId,
      await this.hiddenIds(request.projectId)
    )
    await this.deps.history.writeProjection(request.projectId, remaining)
    return { clearedCount: selected.length }
  }

  /** @throws {AppException} 超额历史的清理决定不能持久化。释放失败留到下次维护。 */
  async pruneOperationRecords(request: PruneVersionRecordsDTO): Promise<void> {
    requireText(request.projectId, '工程身份不正确')
    await this.loadHistory(request.projectId)
    await this.releaseSettledContent(request.projectId)
    await this.pruneSystemHistory(request.projectId)
  }

  private requireCommitRequest(request: CommitVersionOperationDTO): void {
    requireText(request.projectId, '工程身份不正确')
    requireText(request.baselineRef, '基线身份不正确')
    requireText(request.title, '操作名称不正确')
    requireText(request.summary, '操作摘要不正确')
    requireSaveMode(request.saveMode)
    requireContentSource(request.contentSource)
    if (request.input.kind === 'files') {
      for (const change of request.input.changes) requireFileChange(change)
      return
    }
    if (request.input.kind === 'candidate') {
      requireText(request.input.candidateRef, '候选引用不正确')
      return
    }
    fail(ErrorCodes.invalidRequest, '提交内容不正确')
  }

  private async requireRecord(
    projectId: string,
    operationId: string
  ): Promise<VersionOperationRecord> {
    const record = await this.deps.records.read(projectId, operationId)
    if (!record || record.projectId !== projectId || record.operationId !== operationId) {
      fail(ErrorCodes.invalidRequest, '操作尚未准备')
    }
    return record
  }

  private rejectChangedIntent(
    record: VersionOperationRecord,
    fingerprint: string,
    requestedPaths: readonly string[]
  ): void {
    if (!record.commitIntent || record.commitIntent.contentFingerprint === fingerprint) return
    resolveCommitTransition({
      operationId: record.operationId,
      contentFingerprint: fingerprint,
      requestedPaths,
      allowedPaths: record.changePaths,
      watchedPaths: record.watchedPaths,
      fact: {
        operationId: record.operationId,
        contentFingerprint: record.commitIntent.contentFingerprint,
        state: '未提交'
      }
    })
  }

  private commitIntent(
    record: VersionOperationRecord,
    fingerprint: string,
    request: CommitVersionOperationDTO,
    retentions: readonly VersionBoundRetention[]
  ): VersionCommitIntent {
    const historyId = record.commitIntent?.historyId ?? this.deps.nextId()
    if (!OPERATION_ID_PATTERN.test(historyId)) fail(ErrorCodes.invalidRequest, '历史身份不正确')
    return {
      contentFingerprint: fingerprint,
      historyId,
      saveMode: request.saveMode,
      contentSource: request.contentSource,
      title: request.title,
      summary: request.summary,
      retentions
    }
  }

  private async readCommitSnapshot(
    projectId: string,
    operationId: string
  ): Promise<VersionTransactionView | null> {
    try {
      return await this.deps.transactions.readTransaction(projectId, operationId)
    } catch (error) {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '提交结果不明，不能重试', error)
    }
  }

  private async readRollbackSnapshot(
    projectId: string,
    operationId: string
  ): Promise<VersionTransactionView | null> {
    try {
      return await this.deps.transactions.readTransaction(projectId, operationId)
    } catch (error) {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '回退结果不明，不能再次回退', error)
    }
  }

  private async recoverCommit(
    projectId: string,
    operationId: string,
    fingerprint: string,
    original: unknown
  ): Promise<VersionCommitVO | null> {
    let snapshot: VersionTransactionView | null
    try {
      snapshot = await this.deps.transactions.readTransaction(projectId, operationId)
    } catch (error) {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '提交结果不明，不能重试', error)
    }
    if (
      snapshot &&
      snapshot.contentFingerprint === fingerprint &&
      (snapshot.outcome.state === '已提交' || snapshot.outcome.state === '无变更')
    ) {
      return toCommitVo(operationId, snapshot)
    }
    if (!snapshot || snapshot.outcome.state === '未提交') return null
    fail(ProjectVersioningErrorCodes.insufficientEvidence, '提交结果不明，不能重试', original)
  }

  private async recoverRollback(
    projectId: string,
    operationId: string,
    original: unknown
  ): Promise<VersionRollbackVO | null> {
    let snapshot: VersionTransactionView | null
    try {
      snapshot = await this.deps.transactions.readTransaction(projectId, operationId)
    } catch (error) {
      fail(ProjectVersioningErrorCodes.insufficientEvidence, '回退结果不明，不能再次回退', error)
    }
    if (snapshot?.outcome.state === '已回退') return rollbackVo(operationId, snapshot)
    if (
      !snapshot ||
      snapshot.outcome.state === '已提交' ||
      snapshot.outcome.state === '待回退' ||
      snapshot.outcome.state === '未提交' ||
      snapshot.outcome.state === '无变更'
    ) {
      return null
    }
    fail(ProjectVersioningErrorCodes.insufficientEvidence, '回退结果不明，不能再次回退', original)
  }

  private async loadHistory(projectId: string): Promise<readonly VersionHistoryFact[]> {
    const current = await this.deps.history.readProjection(projectId)
    const rebuilt = await this.rebuildHistory(projectId, await this.hiddenIds(projectId))
    if (!current.complete || !sameHistory(current.entries, rebuilt)) {
      await this.deps.history.writeProjection(projectId, rebuilt)
    }
    return rebuilt
  }

  private async rebuildHistory(
    projectId: string,
    hidden: ReadonlySet<string>
  ): Promise<readonly VersionHistoryFact[]> {
    const records = await this.deps.records.listByProject(projectId)
    const entries: VersionHistoryFact[] = []
    for (const record of records) {
      const entry = await this.historyEntry(projectId, record, hidden)
      if (entry) entries.push(entry)
    }
    return entries.sort(byNewestHistory)
  }

  private async historyEntry(
    projectId: string,
    record: VersionOperationRecord,
    hidden: ReadonlySet<string>
  ): Promise<VersionHistoryFact | null> {
    if (record.projectId !== projectId || !record.commitIntent) return null
    if (hidden.has(record.commitIntent.historyId)) return null
    const snapshot = await this.deps.transactions.readTransaction(projectId, record.operationId)
    if (!snapshot) return null
    if (snapshot.contentFingerprint !== record.commitIntent.contentFingerprint) {
      fail(ErrorCodes.internalError, '修订历史暂时无法读取')
    }
    const state = resolveVersionSettlement(toDomainFact(snapshot), record.operationId)
    if (state === '无变更' || state === '未提交' || state === '待核对') return null
    if (
      snapshot.outcome.state !== '已提交' &&
      snapshot.outcome.state !== '已回退' &&
      snapshot.outcome.state !== '待回退'
    ) {
      return null
    }
    if (!CHANGED_AT_PATTERN.test(snapshot.outcome.changedAt)) {
      fail(ErrorCodes.internalError, '修订历史暂时无法读取')
    }
    const visibleState = state === '已回退' ? '已回退' : '已提交'
    return {
      historyId: record.commitIntent.historyId,
      projectId,
      operationId: record.operationId,
      sourceModule: record.sourceModule,
      targets: record.targets,
      saveMode: record.commitIntent.saveMode,
      contentSource: record.commitIntent.contentSource,
      title: record.commitIntent.title,
      summary: record.commitIntent.summary,
      createdAt: snapshot.outcome.changedAt,
      state: visibleState,
      canUndo: visibleState === '已提交',
      canClear: true
    }
  }

  private async hiddenIds(projectId: string): Promise<Set<string>> {
    const markers = await this.deps.history.readClearMarkers(projectId)
    return new Set(markers.map((marker) => marker.historyId))
  }

  private async releaseSettledContent(projectId: string): Promise<void> {
    const records = await this.deps.records.listByProject(projectId)
    for (const record of records) {
      if (!record.commitIntent) continue
      const refs = record.commitIntent.retentions.flatMap((retention) =>
        retention.retentionRef === null ? [] : [retention.retentionRef]
      )
      if (refs.length === 0) continue
      const snapshot = await this.deps.transactions.readTransaction(projectId, record.operationId)
      const state = snapshot?.outcome.state
      if (state !== '已提交' && state !== '无变更' && state !== '已回退') continue
      try {
        await this.deps.content.release({
          projectId,
          operationId: record.operationId,
          retentionRefs: refs
        })
        await this.deps.records.replaceRetentions(
          projectId,
          record.operationId,
          record.commitIntent.retentions.map((retention) => ({ ...retention, retentionRef: null }))
        )
      } catch {
        // 释放失败保留原凭据，下次维护再试，不改已经可靠的结算。
      }
    }
  }

  private async pruneSystemHistory(projectId: string): Promise<void> {
    const entries = await this.rebuildHistory(projectId, await this.hiddenIds(projectId))
    const excess = entries.filter((entry) => entry.saveMode === 'system').slice(SYSTEM_HISTORY_KEEP)
    if (excess.length === 0) return
    const excessIds = excess.map((entry) => entry.historyId)
    await this.deps.history.persistClearMarkers(projectId, excessIds)
    const hidden = new Set(excessIds)
    await this.deps.history.writeProjection(
      projectId,
      entries.filter((entry) => !hidden.has(entry.historyId))
    )
  }

  private async maintainQuietly(projectId: string): Promise<void> {
    try {
      await this.loadHistory(projectId)
      await this.releaseSettledContent(projectId)
      await this.pruneSystemHistory(projectId)
    } catch {
      try {
        await this.deps.history.markIncomplete(projectId)
      } catch {
        // 投影连失效标记都写不进去时，下次读取仍按不完整事实处理。
      }
    }
  }
}

/** 显式回退把可靠已提交视为待回退；未提交、无变更和待核对仍交给领域规则拒绝。 */
function toRollbackFact(view: VersionTransactionView | null): VersionTransactionFact | null {
  if (!view) return null
  return {
    operationId: view.operationId,
    contentFingerprint: view.contentFingerprint,
    state: view.outcome.state === '已提交' ? '待回退' : view.outcome.state
  }
}

function toDomainFact(view: VersionTransactionView): VersionTransactionFact {
  return {
    operationId: view.operationId,
    contentFingerprint: view.contentFingerprint,
    state: view.outcome.state
  }
}

function toSettlement(
  operationId: string,
  view: VersionTransactionView | null,
  intentFingerprint: string | null
): VersionSettlementVO {
  if (!view || (intentFingerprint !== null && intentFingerprint !== view.contentFingerprint)) {
    resolveVersionSettlement(null, operationId)
    return { operationId, state: '待核对' }
  }
  const state = resolveVersionSettlement(toDomainFact(view), operationId)
  if (state !== view.outcome.state) return { operationId, state: '待核对' }
  switch (view.outcome.state) {
    case '已提交':
    case '无变更':
    case '待回退':
      return { operationId, state: view.outcome.state, revisionRef: view.outcome.revisionRef }
    case '已回退':
      return {
        operationId,
        state: '已回退',
        originalRevisionRef: view.outcome.originalRevisionRef,
        revisionRef: view.outcome.revisionRef
      }
    case '未提交':
      return { operationId, state: '未提交' }
    case '待核对':
      return { operationId, state: '待核对' }
  }
}

function toCommitVo(operationId: string, view: VersionTransactionView): VersionCommitVO {
  if (view.outcome.state !== '已提交' && view.outcome.state !== '无变更') {
    fail(ProjectVersioningErrorCodes.illegalStateTransition, '当前操作状态不能继续提交')
  }
  return { operationId, state: view.outcome.state, revisionRef: view.outcome.revisionRef }
}

function rollbackVo(operationId: string, view: VersionTransactionView | null): VersionRollbackVO {
  if (!view || view.outcome.state !== '已回退') {
    fail(ProjectVersioningErrorCodes.insufficientEvidence, '回退结果不明，不能再次回退')
  }
  return { operationId, state: '已回退', revisionRef: view.outcome.revisionRef }
}

function fingerprintOf(request: CommitVersionOperationDTO): string {
  const hash = createHash('sha256')
  const write = (value: string): void => {
    hash.update(value)
    hash.update('\0')
  }
  write(request.saveMode)
  write(request.contentSource)
  write(request.title)
  write(request.summary)
  if (request.input.kind === 'candidate') {
    write('candidate')
    write(request.input.candidateRef)
    for (const change of sortedChanges(request.input.changes)) {
      write(change.relativePath)
      write(change.action)
    }
  } else {
    write('files')
    for (const change of sortedChanges(request.input.changes)) {
      write(change.relativePath)
      write(change.action)
      if (change.action === 'delete') continue
      if (change.content.kind === 'bytes') {
        write('bytes')
        hash.update(change.content.bytes)
        hash.update('\0')
      } else {
        write('prepared')
        write(change.content.contentRef)
      }
    }
  }
  return hash.digest('hex')
}

function sortedChanges<T extends { relativePath: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )
}

function requireMatchingRetentions(
  input: FileChangesInputDTO | ImmutableCandidateInputDTO,
  retentions: readonly VersionBoundRetention[]
): void {
  if (retentions.length !== input.changes.length) {
    fail(ErrorCodes.internalError, '内容保留与声明变更不一致')
  }
  for (const [index, retention] of retentions.entries()) {
    const change = input.changes[index]
    if (
      !change ||
      retention.relativePath !== change.relativePath ||
      retention.action !== change.action
    ) {
      fail(ErrorCodes.internalError, '内容保留与声明变更不一致')
    }
    if (change.action === 'delete') {
      if (retention.retentionRef !== null) {
        fail(ErrorCodes.internalError, '删除不保留内容凭据')
      }
      continue
    }
    if (typeof retention.retentionRef !== 'string' || retention.retentionRef.trim() === '') {
      fail(ErrorCodes.internalError, '内容保留与声明变更不一致')
    }
  }
}

function assertDeclaredPaths(
  operationId: string,
  changePaths: readonly string[],
  watchedPaths: readonly string[]
): void {
  bindPreparedOperation({
    operationId,
    contentFingerprint: SCOPE_FINGERPRINT,
    changePaths,
    watchedPaths
  })
  assertRepositoryPaths(changePaths)
  assertRepositoryPaths(watchedPaths)
}

function assertRepositoryPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)) {
      fail(ProjectVersioningErrorCodes.pathOutOfScope, '路径必须位于工程内')
    }
    if (
      path
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..' || part === '.git')
    ) {
      fail(ProjectVersioningErrorCodes.pathOutOfScope, '路径必须位于工程内')
    }
  }
}

function copyTarget(target: VersionTarget): VersionTarget {
  requireText(target.kind, '业务目标不正确')
  requireText(target.id, '业务目标不正确')
  return { kind: target.kind, id: target.id }
}

function requireFileChange(change: VersionFileChange): void {
  if (change.action === 'delete') return
  if (change.content.kind === 'bytes') {
    if (!(change.content.bytes instanceof Uint8Array)) {
      fail(ErrorCodes.invalidRequest, '文件内容不正确')
    }
    return
  }
  if (change.content.kind === 'prepared') {
    requireText(change.content.contentRef, '内容引用不正确')
    return
  }
  fail(ErrorCodes.invalidRequest, '文件内容不正确')
}

function requireSaveMode(value: string): asserts value is VersionSaveMode {
  if (value !== 'manual' && value !== 'system') fail(ErrorCodes.invalidRequest, '保存方式不正确')
}

function requireContentSource(value: string): asserts value is VersionContentSource {
  if (value !== 'operation' && value !== 'ai') fail(ErrorCodes.invalidRequest, '内容来源不正确')
}

function requireText(value: string, message: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    fail(ErrorCodes.invalidRequest, message)
  }
}

function fail(code: number, msg: string, cause?: unknown): never {
  throw new AppException({ code, msg, cause })
}

function matchesQuery(entry: VersionHistoryFact, request: ListVersionHistoryDTO): boolean {
  if (request.sourceModule !== undefined && entry.sourceModule !== request.sourceModule)
    return false
  if (request.saveMode !== undefined && entry.saveMode !== request.saveMode) return false
  if (request.contentSource !== undefined && entry.contentSource !== request.contentSource)
    return false
  if (request.target === undefined) return true
  return entry.targets.some(
    (target) => target.kind === request.target?.kind && target.id === request.target?.id
  )
}

function pageHistory(
  entries: readonly VersionHistoryFact[],
  request: ListVersionHistoryDTO
): VersionHistoryPageVO {
  let start = 0
  if (request.cursor !== undefined) {
    const index = entries.findIndex((entry) => entry.historyId === request.cursor)
    if (index < 0) fail(ErrorCodes.invalidRequest, '历史游标不正确')
    start = index + 1
  }
  const slice = entries.slice(start, start + request.pageSize)
  const last = slice.at(-1)
  return {
    entries: slice.map((entry) => ({
      historyId: entry.historyId,
      sourceModule: entry.sourceModule,
      targets: entry.targets,
      saveMode: entry.saveMode,
      contentSource: entry.contentSource,
      title: entry.title,
      summary: entry.summary,
      createdAt: entry.createdAt,
      state: entry.state,
      canUndo: entry.canUndo,
      canClear: entry.canClear
    })),
    nextCursor: last && start + slice.length < entries.length ? last.historyId : null
  }
}

function selectHistory(
  entries: readonly VersionHistoryFact[],
  selection: ClearVersionHistoryDTO['selection']
): readonly VersionHistoryFact[] {
  if (selection.kind === 'entry') {
    requireText(selection.historyId, '历史条目不正确')
    const entry = entries.find((item) => item.historyId === selection.historyId)
    if (!entry) fail(ErrorCodes.invalidRequest, '历史条目不存在')
    return [entry]
  }
  requireText(selection.throughHistoryId, '历史边界不正确')
  requireSaveMode(selection.saveMode)
  if (selection.sourceModule !== undefined) requireText(selection.sourceModule, '来源模块不正确')
  if (selection.target !== undefined) copyTarget(selection.target)
  if (selection.contentSource !== undefined) requireContentSource(selection.contentSource)
  const boundary = entries.findIndex((entry) => entry.historyId === selection.throughHistoryId)
  if (boundary < 0) fail(ErrorCodes.invalidRequest, '历史边界不属于当前工程')
  return entries.filter((entry, index) => index >= boundary && matchesCategory(entry, selection))
}

function matchesCategory(
  entry: VersionHistoryFact,
  selection: Extract<ClearVersionHistoryDTO['selection'], { kind: 'category' }>
): boolean {
  if (entry.saveMode !== selection.saveMode) return false
  if (selection.sourceModule !== undefined && entry.sourceModule !== selection.sourceModule)
    return false
  if (selection.contentSource !== undefined && entry.contentSource !== selection.contentSource)
    return false
  if (selection.target === undefined) return true
  return entry.targets.some(
    (target) => target.kind === selection.target?.kind && target.id === selection.target?.id
  )
}

function sameHistory(
  current: readonly VersionHistoryFact[],
  rebuilt: readonly VersionHistoryFact[]
): boolean {
  if (current.length !== rebuilt.length) return false
  return current.every((entry, index) => {
    const other = rebuilt[index]
    return (
      other !== undefined &&
      entry.historyId === other.historyId &&
      entry.state === other.state &&
      entry.createdAt === other.createdAt &&
      entry.canUndo === other.canUndo &&
      entry.operationId === other.operationId
    )
  })
}

function byNewestHistory(left: VersionHistoryFact, right: VersionHistoryFact): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.historyId < right.historyId ? 1 : left.historyId > right.historyId ? -1 : 0
}
