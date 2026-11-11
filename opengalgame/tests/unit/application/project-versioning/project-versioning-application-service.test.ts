import { describe, expect, it } from 'vitest'

import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type {
  CommitVersionOperationDTO,
  VersionSaveMode
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { VersionContentGateway } from '@application/project-versioning/ports/VersionContentGateway'
import type {
  VersionClearMarker,
  VersionHistoryGateway,
  VersionHistoryProjection
} from '@application/project-versioning/ports/VersionHistoryGateway'
import type {
  VersionOperationRecord,
  VersionOperationRecordGateway,
  VersionPreparedRecord
} from '@application/project-versioning/ports/VersionOperationRecordGateway'
import type {
  VersionBaselineFact,
  VersionCommitExecution,
  VersionRollbackExecution,
  VersionTransactionGateway,
  VersionTransactionView
} from '@application/project-versioning/ports/VersionTransactionGateway'
import type { VersionCommitVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'

const projectId = 'project-1'

type OutcomeMode = 'commit' | 'no-change' | 'unknown'

class MemoryVersionPorts {
  baseline: VersionBaselineFact | null = null
  boundaryOpen = false
  subsequentPaths: string[] = []
  outcome: OutcomeMode = 'commit'
  revisionRefs: string[] = []
  bindCommitError: AppException | null = null
  private clock = 0
  private revision = 0
  private readonly transactions = new Map<string, VersionTransactionView>()
  private readonly records = new Map<string, VersionOperationRecord>()
  private readonly retained = new Map<
    string,
    { fingerprint: string; retentions: readonly VersionBoundRetention[] }
  >()
  private projection: VersionHistoryProjection = { complete: false, entries: [] }
  private markers: VersionClearMarker[] = []

  readonly transactionGateway: VersionTransactionGateway = {
    initializeBaseline: async (input) => {
      this.baseline = { baselineRef: `baseline-${input.projectId}`, revisionRef: 'rev-0' }
      return this.baseline
    },
    readBaseline: async () => this.baseline,
    inspectDeclaredPaths: async () => this.baseline !== null,
    readTransaction: async (project, operationId) =>
      this.transactions.get(key(project, operationId)) ?? null,
    commit: async (input) => {
      this.boundaryOpen = true
      try {
        const decision = await input.verify({
          baseline: this.requireBaseline(),
          subsequentPaths: this.subsequentPaths,
          transaction: this.transactions.get(key(input.projectId, input.operationId)) ?? null
        })
        if (decision.action === 'reuse') return this.reuseCommit(input.projectId, input.operationId)
        return this.publishCommit(input.projectId, input.operationId, input.contentFingerprint)
      } finally {
        this.boundaryOpen = false
      }
    },
    rollback: async (input) => {
      this.boundaryOpen = true
      try {
        const decision = await input.verify({
          subsequentPaths: this.subsequentPaths,
          transaction: this.transactions.get(key(input.projectId, input.operationId)) ?? null
        })
        if (decision.action === 'reuse')
          return this.reuseRollback(input.projectId, input.operationId)
        return this.publishRollback(input.projectId, input.operationId)
      } finally {
        this.boundaryOpen = false
      }
    }
  }

  readonly recordGateway: VersionOperationRecordGateway = {
    bindPrepared: async (record: VersionPreparedRecord) => {
      this.records.set(key(record.projectId, record.operationId), { ...record, commitIntent: null })
    },
    read: async (project, operationId) => this.records.get(key(project, operationId)) ?? null,
    bindCommitIntent: async (project, operationId, intent) => {
      if (this.bindCommitError) throw this.bindCommitError
      const record = this.records.get(key(project, operationId))
      if (!record) throw new Error('missing prepared operation')
      if (
        record.commitIntent &&
        record.commitIntent.contentFingerprint !== intent.contentFingerprint
      ) {
        throw new AppException({
          code: ProjectVersioningErrorCodes.contentFingerprintConflict,
          msg: '同一操作不能更换内容'
        })
      }
      const stored = record.commitIntent
        ? { ...intent, historyId: record.commitIntent.historyId }
        : intent
      this.records.set(key(project, operationId), { ...record, commitIntent: stored })
    },
    listByProject: async (project) =>
      [...this.records.values()].filter((record) => record.projectId === project),
    replaceRetentions: async (project, operationId, retentions) => {
      const record = this.records.get(key(project, operationId))
      if (!record?.commitIntent) throw new Error('missing commit intent')
      this.records.set(key(project, operationId), {
        ...record,
        commitIntent: { ...record.commitIntent, retentions }
      })
    },
    bindCallerOperation: async () => undefined,
    readCallerOperation: async () => null,
    findCallerOperation: async () => null
  }

  readonly contentGateway: VersionContentGateway = {
    retain: async (input) => {
      const id = key(input.projectId, input.operationId)
      const existing = this.retained.get(id)
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new AppException({
            code: ProjectVersioningErrorCodes.contentFingerprintConflict,
            msg: '同一操作不能更换内容'
          })
        }
        return existing.retentions
      }
      const retentions = input.input.changes.map((change, index) => ({
        relativePath: change.relativePath,
        action: change.action,
        retentionRef: change.action === 'delete' ? null : `keep-${input.operationId}-${index}`
      }))
      this.retained.set(id, { fingerprint: input.fingerprint, retentions })
      return retentions
    },
    release: async (input) => {
      const id = key(input.projectId, input.operationId)
      const existing = this.retained.get(id)
      if (!existing) return
      this.retained.set(id, {
        fingerprint: existing.fingerprint,
        retentions: existing.retentions.map((retention) => ({ ...retention, retentionRef: null }))
      })
    }
  }

  readonly historyGateway: VersionHistoryGateway = {
    readProjection: async () => this.projection,
    writeProjection: async (_project, entries) => {
      this.projection = { complete: true, entries: [...entries] }
    },
    markIncomplete: async () => {
      this.projection = { ...this.projection, complete: false }
    },
    readClearMarkers: async (project) =>
      this.markers.filter((marker) => marker.projectId === project),
    persistClearMarkers: async (project, historyIds) => {
      for (const historyId of historyIds) {
        if (
          this.markers.some(
            (marker) => marker.projectId === project && marker.historyId === historyId
          )
        ) {
          continue
        }
        this.markers.push({ projectId: project, historyId })
      }
    },
    resolveActive: async (project, historyId) => {
      if (!this.projection.complete) {
        throw new AppException({ code: ErrorCodes.internalError, msg: '修订历史暂时无法读取' })
      }
      if (
        this.markers.some(
          (marker) => marker.projectId === project && marker.historyId === historyId
        )
      ) {
        return null
      }
      const entry = this.projection.entries.find(
        (item) => item.projectId === project && item.historyId === historyId
      )
      return entry ? { operationId: entry.operationId } : null
    }
  }

  private requireBaseline(): VersionBaselineFact {
    if (!this.baseline) throw new Error('missing baseline')
    return this.baseline
  }

  private nextTime(): string {
    this.clock += 1
    return `2026-10-18T00:00:${String(this.clock).padStart(2, '0')}.000Z`
  }

  private publishCommit(
    project: string,
    operationId: string,
    contentFingerprint: string
  ): VersionCommitExecution {
    if (this.outcome === 'unknown') {
      this.transactions.set(key(project, operationId), {
        operationId,
        contentFingerprint,
        outcome: { state: '待核对' }
      })
      return { state: '待核对' }
    }
    const changedAt = this.nextTime()
    if (this.outcome === 'no-change') {
      const revisionRef = this.requireBaseline().revisionRef
      this.transactions.set(key(project, operationId), {
        operationId,
        contentFingerprint,
        outcome: { state: '无变更', revisionRef, changedAt }
      })
      return { state: '无变更', revisionRef, changedAt }
    }
    this.revision += 1
    const revisionRef = `rev-${this.revision}`
    this.revisionRefs.push(revisionRef)
    this.transactions.set(key(project, operationId), {
      operationId,
      contentFingerprint,
      outcome: { state: '已提交', revisionRef, changedAt }
    })
    return { state: '已提交', revisionRef, changedAt }
  }

  private reuseCommit(project: string, operationId: string): VersionCommitExecution {
    const current = this.transactions.get(key(project, operationId))
    if (!current || (current.outcome.state !== '已提交' && current.outcome.state !== '无变更')) {
      return { state: '待核对' }
    }
    return {
      state: current.outcome.state,
      revisionRef: current.outcome.revisionRef,
      changedAt: current.outcome.changedAt
    }
  }

  private publishRollback(project: string, operationId: string): VersionRollbackExecution {
    const current = this.transactions.get(key(project, operationId))
    if (!current || (current.outcome.state !== '已提交' && current.outcome.state !== '待回退')) {
      return { state: '待核对' }
    }
    this.revision += 1
    const revisionRef = `rev-${this.revision}`
    this.revisionRefs.push(revisionRef)
    const execution = {
      state: '已回退' as const,
      originalRevisionRef: current.outcome.revisionRef,
      revisionRef,
      changedAt: current.outcome.changedAt
    }
    this.transactions.set(key(project, operationId), {
      operationId,
      contentFingerprint: current.contentFingerprint,
      outcome: execution
    })
    return execution
  }

  private reuseRollback(project: string, operationId: string): VersionRollbackExecution {
    const current = this.transactions.get(key(project, operationId))
    if (!current || current.outcome.state !== '已回退') return { state: '待核对' }
    return {
      state: '已回退',
      originalRevisionRef: current.outcome.originalRevisionRef,
      revisionRef: current.outcome.revisionRef,
      changedAt: current.outcome.changedAt
    }
  }
}

function key(project: string, operationId: string): string {
  return `${project}:${operationId}`
}

function createService(): {
  service: ProjectVersioningApplicationService
  ports: MemoryVersionPorts
} {
  const ports = new MemoryVersionPorts()
  let sequence = 0
  const service = new ProjectVersioningApplicationServiceImpl({
    transactions: ports.transactionGateway,
    records: ports.recordGateway,
    content: ports.contentGateway,
    history: ports.historyGateway,
    nextId: () => `id-${++sequence}`
  })
  return { service, ports }
}

async function withBaseline(
  ports: MemoryVersionPorts,
  service: ProjectVersioningApplicationService
): Promise<void> {
  await service.initializeBaseline({ projectId, initialPaths: ['story/a.txt'] })
  if (!ports.baseline) throw new Error('baseline was not stored')
}

function commitRequest(
  operationId: string,
  baselineRef: string,
  bytes: readonly number[],
  title: string,
  saveMode: VersionSaveMode
): CommitVersionOperationDTO {
  return {
    projectId,
    operationId,
    baselineRef,
    input: {
      kind: 'files',
      changes: [
        {
          relativePath: 'story/a.txt',
          action: 'modify',
          content: { kind: 'bytes', bytes: Uint8Array.from(bytes) }
        }
      ]
    },
    saveMode,
    contentSource: 'operation',
    title,
    summary: '保存摘要'
  }
}

async function commitNew(
  service: ProjectVersioningApplicationService,
  bytes: readonly number[],
  title: string,
  saveMode: VersionSaveMode = 'system'
): Promise<{ operationId: string; result: VersionCommitVO }> {
  const prepared = await service.prepareOperation({
    projectId,
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene', id: 'scene-1' }],
    changePaths: ['story/a.txt'],
    watchedPaths: ['story/watch.txt']
  })
  const result = await service.commitOperation(
    commitRequest(prepared.operationId, prepared.baselineRef, bytes, title, saveMode),
    () => undefined
  )
  return { operationId: prepared.operationId, result }
}

async function expectCode(run: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect((error as AppException).code).toBe(code)
    return
  }
  throw new Error(`expected AppException ${code}`)
}

describe('版本应用编排', () => {
  it('拒绝同一操作更换内容，并保留已经提交的版本', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    const first = await commitNew(service, [1], '第一次保存')
    const prepared = await service.prepareOperation({
      projectId,
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story/a.txt'],
      watchedPaths: []
    })
    await expectCode(
      () =>
        service.commitOperation(
          commitRequest(first.operationId, prepared.baselineRef, [9], '第一次保存', 'system'),
          () => undefined
        ),
      ProjectVersioningErrorCodes.contentFingerprintConflict
    )
    expect(ports.revisionRefs).toEqual([first.result.revisionRef])
    await expect(
      service.readOperationSettlement({ projectId, operationId: first.operationId })
    ).resolves.toEqual({
      operationId: first.operationId,
      state: '已提交',
      revisionRef: first.result.revisionRef
    })
  })

  it('提交意图绑定失败时不发布作品', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    ports.bindCommitError = new AppException({
      code: ErrorCodes.internalError,
      msg: '意图没有绑定'
    })
    const prepared = await service.prepareOperation({
      projectId,
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story/a.txt'],
      watchedPaths: []
    })
    await expectCode(
      () =>
        service.commitOperation(
          commitRequest(prepared.operationId, prepared.baselineRef, [1], '未绑定', 'manual'),
          () => undefined
        ),
      ErrorCodes.internalError
    )
    expect(ports.revisionRefs).toEqual([])
    expect(ports.boundaryOpen).toBe(false)
  })

  it('在短提交边界内拒绝业务前置条件，并且不发布', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    const prepared = await service.prepareOperation({
      projectId,
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story/a.txt'],
      watchedPaths: ['story/watch.txt']
    })
    await expectCode(
      () =>
        service.commitOperation(
          commitRequest(prepared.operationId, prepared.baselineRef, [1], '被拒绝', 'manual'),
          () => {
            expect(ports.boundaryOpen).toBe(true)
            throw new AppException({ code: ErrorCodes.forbidden, msg: '前置条件不成立' })
          }
        ),
      ErrorCodes.forbidden
    )
    expect(ports.revisionRefs).toEqual([])
    expect(ports.boundaryOpen).toBe(false)
  })

  it('可靠提交再次提交时不依赖来源内容', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    const prepared = await service.prepareOperation({
      projectId,
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story/a.txt'],
      watchedPaths: []
    })
    const request = commitRequest(
      prepared.operationId,
      prepared.baselineRef,
      [4],
      '可重试',
      'manual'
    )
    const first = await service.commitOperation(request, () => undefined)
    ports.contentGateway.retain = async () => {
      throw new Error('source content is gone')
    }
    const second = await service.commitOperation(request, () => {
      throw new Error('preconditions must not run for an existing result')
    })
    expect(second).toEqual(first)
    expect(ports.revisionRefs).toEqual([first.revisionRef])
  })

  it('结果不明时不再次发布，只读结算保持待核对', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    ports.outcome = 'unknown'
    const prepared = await service.prepareOperation({
      projectId,
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story/a.txt'],
      watchedPaths: []
    })
    const request = commitRequest(prepared.operationId, prepared.baselineRef, [5], '不明', 'system')
    await expectCode(
      () => service.commitOperation(request, () => undefined),
      ProjectVersioningErrorCodes.insufficientEvidence
    )
    ports.contentGateway.retain = async () => {
      throw new Error('unknown result must not retain again')
    }
    ports.transactionGateway.commit = async () => {
      throw new Error('unknown result must not publish again')
    }
    await expectCode(
      () => service.commitOperation(request, () => undefined),
      ProjectVersioningErrorCodes.illegalStateTransition
    )
    ports.contentGateway.release = async () => {
      throw new Error('settlement read must not release')
    }
    await expect(
      service.readOperationSettlement({ projectId, operationId: prepared.operationId })
    ).resolves.toEqual({
      operationId: prepared.operationId,
      state: '待核对'
    })
    await expect(service.listHistory({ projectId, pageSize: 10 })).resolves.toEqual({
      entries: [],
      nextCursor: null
    })
    expect(ports.revisionRefs).toEqual([])
  })

  it('无变更形成可靠版本，但不展示用户历史', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    ports.outcome = 'no-change'
    const saved = await commitNew(service, [1], '没有变化', 'manual')
    expect(saved.result).toEqual({
      operationId: saved.operationId,
      state: '无变更',
      revisionRef: 'rev-0'
    })
    await expect(
      service.readOperationSettlement({ projectId, operationId: saved.operationId })
    ).resolves.toEqual(saved.result)
    await expect(service.listHistory({ projectId, pageSize: 10 })).resolves.toEqual({
      entries: [],
      nextCursor: null
    })
    expect(ports.revisionRefs).toEqual([])
  })

  it('历史撤销复用受控回退，重复回退不追加提交', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    const saved = await commitNew(service, [7], '可撤销', 'manual')
    const page = await service.listHistory({ projectId, pageSize: 10 })
    const entry = page.entries[0]
    expect(entry).toMatchObject({ title: '可撤销', state: '已提交', canUndo: true })
    await expect(
      service.undoHistoryEntry({ projectId, historyId: entry?.historyId ?? '' })
    ).resolves.toEqual({ historyId: entry?.historyId, state: '已回退' })
    const after = await service.listHistory({ projectId, pageSize: 10 })
    expect(after.entries[0]).toMatchObject({ state: '已回退', canUndo: false })
    const settlement = await service.readOperationSettlement({
      projectId,
      operationId: saved.operationId
    })
    expect(settlement).toMatchObject({
      state: '已回退',
      originalRevisionRef: saved.result.revisionRef
    })
    if (settlement.state !== '已回退') throw new Error('missing rollback revision')
    ports.transactionGateway.rollback = async () => {
      throw new Error('existing rollback must not append')
    }
    await expect(
      service.rollbackOperation({ projectId, operationId: saved.operationId })
    ).resolves.toEqual({
      operationId: saved.operationId,
      state: '已回退',
      revisionRef: settlement.revisionRef
    })
    expect(ports.revisionRefs).toEqual([saved.result.revisionRef, settlement.revisionRef])
  })

  it('目标已有后续修改时拒绝回退，原提交保持不变', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    const saved = await commitNew(service, [8], '不能覆盖', 'manual')
    ports.subsequentPaths = ['story/a.txt']
    await expectCode(
      () => service.rollbackOperation({ projectId, operationId: saved.operationId }),
      ErrorCodes.operationConflict
    )
    await expect(
      service.readOperationSettlement({ projectId, operationId: saved.operationId })
    ).resolves.toEqual({
      operationId: saved.operationId,
      state: '已提交',
      revisionRef: saved.result.revisionRef
    })
    expect(ports.revisionRefs).toEqual([saved.result.revisionRef])
  })

  it('类别清理停在确认边界，不带走更新的记录、手动保存和作品结算', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    const older = await commitNew(service, [1], '系统旧', 'system')
    await commitNew(service, [2], '手动', 'manual')
    await commitNew(service, [3], '系统边界', 'system')
    await commitNew(service, [4], '系统新', 'system')
    const page = await service.listHistory({ projectId, pageSize: 10 })
    const boundaryEntry = page.entries.find((entry) => entry.title === '系统边界')
    await expect(
      service.clearHistory({
        projectId,
        selection: {
          kind: 'category',
          saveMode: 'system',
          throughHistoryId: boundaryEntry?.historyId ?? ''
        }
      })
    ).resolves.toEqual({ clearedCount: 2 })
    const after = await service.listHistory({ projectId, pageSize: 10 })
    expect(after.entries.map((entry) => entry.title)).toEqual(['系统新', '手动'])
    await expect(
      service.readOperationSettlement({ projectId, operationId: older.operationId })
    ).resolves.toEqual({
      operationId: older.operationId,
      state: '已提交',
      revisionRef: older.result.revisionRef
    })
    expect(ports.revisionRefs).toHaveLength(4)
  })

  it('没有可靠基线时准备操作失败，并且不留下操作', async () => {
    const { service, ports } = createService()
    await expectCode(
      () =>
        service.prepareOperation({
          projectId,
          sourceModule: 'scene-canvas',
          targets: [{ kind: 'scene', id: 'scene-1' }],
          changePaths: ['story/a.txt'],
          watchedPaths: []
        }),
      ProjectVersioningErrorCodes.gitNoCommits
    )
    await expect(ports.recordGateway.listByProject(projectId)).resolves.toEqual([])
  })

  it('历史投影失败不把已经提交的作品改判为失败，也不再次发布', async () => {
    const { service, ports } = createService()
    await withBaseline(ports, service)
    ports.historyGateway.writeProjection = async () => {
      throw new AppException({ code: ErrorCodes.internalError, msg: '索引写入失败' })
    }
    const saved = await commitNew(service, [6], '索引失败', 'system')
    ports.transactionGateway.commit = async () => {
      throw new Error('index failure must not republish')
    }
    ports.contentGateway.retain = async () => {
      throw new Error('index failure must not retain again')
    }
    const prepared = await service.readOperationSettlement({
      projectId,
      operationId: saved.operationId
    })
    expect(prepared).toEqual(saved.result)
    const request = commitRequest(
      saved.operationId,
      'baseline-project-1',
      [6],
      '索引失败',
      'system'
    )
    await expect(service.commitOperation(request, () => undefined)).resolves.toEqual(saved.result)
    await expectCode(
      () => service.listHistory({ projectId, pageSize: 10 }),
      ErrorCodes.internalError
    )
    expect(ports.revisionRefs).toEqual([saved.result.revisionRef])
  })
})
