import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneCandidateWriteRecoveryResult,
  SceneGenerationWriteRecovery
} from '@application/scene-generation/ports/SceneGenerationWriteRecovery'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import { finishCandidateEffect } from '@infrastructure/workflow/execution/candidateSettlement'
import {
  assertWorkflowSegment,
  type WorkflowIdentity
} from '@infrastructure/workflow/WorkflowIdentity'
import {
  isPiReviewCheckpointId,
  piReviewCheckpointId
} from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import {
  candidateInputDigest,
  type CandidateInputFacts
} from '@infrastructure/scene-generation/workflow/graph/candidateRevision'

const STEP_PATTERN = /^(generate|repair)-(\d+)(?:-([0-9a-f]{16}))?$/u

type RevisionGateway = Pick<SceneArtifactGateway, 'verifyRevision'>

/**
 * 用副作用账本、不可变修订归属和实际候选工作区证明候选写入。
 * 只在证据完整时补结算；任何缺口只返回待核对事实，不清理工作区、不写入候选、不提交作品。
 */
export class ConfirmedWriteRecovery implements SceneGenerationWriteRecovery {
  constructor(
    private readonly stateRoot: string,
    private readonly files: AiProjectFileSystemImpl,
    private readonly artifacts: RevisionGateway,
    /**
     * 分叉父修订的独立来源证明。必须核对建分叉时捕获的不可变证据，
     * 不能读取来源操作当前检查点，也不能把持久 fork 字段本身当证据。
     */
    private readonly verifyForkSource?: (
      execution: SceneGenerationExecution,
      revisionId: string
    ) => Promise<boolean>
  ) {}

  async recoverCandidateWrite(
    execution: SceneGenerationExecution,
    bindCandidate: (candidateSnapshotId: string) => Promise<void>
  ): Promise<SceneCandidateWriteRecoveryResult> {
    const readingBoundary = this.isReadingBoundary(execution)
    let effects: DurableEffectRecord[]
    try {
      effects = await readDurableEffects(this.stateRoot, execution)
    } catch (error) {
      // 账本不可读不等于没有写入：任何可能已有工作区、候选或运行中的执行都先保留现场。
      return this.mayHavePendingWrite(execution, readingBoundary)
        ? {
            outcome: 'unprovable',
            reason: '副作用账本无法读取，已保留记录待核对',
            cause: error
          }
        : { outcome: 'notApplicable' }
    }
    const inFlight = effects.some(
      (effect) => effect.status === 'started' || effect.status === 'unknown'
    )
    // 崩溃可能停在首次写入开始、修订尚未记录，或记录后完成回执之前；
    // 这些状态都没有可靠的 checkpoint 条件可以用来跳过旧账本。
    const unsettledExecution = await this.isUnsettledExecution(execution)
    if (!readingBoundary && !inFlight && !unsettledExecution)
      return { outcome: 'notApplicable' }
    if (effects.length === 0) {
      // 工作区引用已出现但执行记录还没有候选，说明账本可能缺失而不是从未写入；
      // 不能按已知空账本恢复。分叉/修复物化的已绑定引用不在这里误判。
      if (!readingBoundary) {
        if (execution.candidateSnapshotId === undefined && unsettledExecution)
          return {
            outcome: 'unprovable',
            reason: '工作区已出现未归属修订且缺少副作用账本，已保留记录待核对'
          }
        return { outcome: 'notApplicable' }
      }
      return {
        outcome: 'unprovable',
        reason: '写后读取边界缺少副作用账本，已保留记录待核对'
      }
    }
    try {
      const proof = await this.prove(execution, effects, readingBoundary)
      if (proof === undefined) return { outcome: 'notApplicable' }
      // 固定顺序：先把已证明的候选绑定到执行记录，再补完成回执。二者之间再次中断时，
      // 下一次会按 in-flight started 记录重新证明并只补一次 completed。
      if (proof.candidateSnapshotId !== execution.candidateSnapshotId)
        await bindCandidate(proof.candidateSnapshotId)
      if (proof.settle)
        await this.settle(execution, proof.record, proof.candidateSnapshotId)
      return {
        outcome: 'proven',
        candidateSnapshotId: proof.candidateSnapshotId,
        settled: proof.settle,
        carryReadingStage: readingBoundary,
        checkpointSuperseded:
          execution.checkpointId !== undefined &&
          execution.checkpointId !==
            piReviewCheckpointId(execution.operationId, proof.candidateSnapshotId)
      }
    } catch (error) {
      const retained = await this.retainedCandidate(execution)
      return retained === undefined
        ? {
            outcome: 'unprovable',
            reason: '候选写入归属无法证明，已保留记录待核对',
            cause: error
          }
        : {
            outcome: 'unprovable',
            reason: '候选写入归属无法证明，已保留记录待核对',
            candidateSnapshotId: retained,
            cause: error
          }
    }
  }

  /**
   * 账本读取失败时判断是否必须先停下保留现场。运行中、待运行或已有工作区/候选的执行
   * 都可能含有未结算写入；只有可证明没有这些事实的空执行才可当作无需恢复。
   */
  private mayHavePendingWrite(
    execution: SceneGenerationExecution,
    readingBoundary: boolean
  ): boolean {
    return (
      readingBoundary ||
      execution.state === 'running' ||
      execution.state === 'pending' ||
      execution.candidateSnapshotId !== undefined ||
      execution.workspace !== undefined ||
      execution.repairInputSnapshotId !== undefined
    )
  }

  private isReadingBoundary(execution: SceneGenerationExecution): boolean {
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined) return false
    if (execution.checkpointId !== piReviewCheckpointId(execution.operationId, candidateSnapshotId))
      return false
    return execution.interruptReason === 'readInterrupted' || execution.step === 'reading'
  }

  /**
   * 运行中重开且检查点不再对应当前候选，或工作区引用已经领先执行记录时，
   * 必须先证明旧写入；不能因为 checkpointId 非空就跳过恢复门。
   */
  private async isUnsettledExecution(
    execution: SceneGenerationExecution
  ): Promise<boolean> {
    if (execution.state !== 'running' && execution.state !== 'pending') return false
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined) {
      // 完成回执已写、候选尚未绑定：工作区引用是唯一还没被执行记录承认的写入事实。
      // 修复物化修订不是候选，不能因为它的引用把正常修复起点当成待恢复写入。
      try {
        const current = await this.files.currentWorkspaceRevision(this.identityOf(execution))
        return current !== undefined && current !== execution.repairInputSnapshotId
      } catch {
        return true
      }
    }
    if (execution.checkpointId === undefined) return true
    if (
      isPiReviewCheckpointId(execution.checkpointId) &&
      execution.checkpointId !==
        piReviewCheckpointId(execution.operationId, candidateSnapshotId)
    )
      return true
    try {
      const current = await this.files.currentWorkspaceRevision(this.identityOf(execution))
      return current !== undefined && current !== candidateSnapshotId
    } catch {
      // 引用不可读时不能证明工作区没有领先；交给证明阶段保留现场。
      return true
    }
  }

  /**
   * @returns 已证明的候选与待补的 started 记录；账本没有可证明写入时为空。
   * @throws 身份、步骤、摘要、修订归属或工作区内容任一不符。
   */
  private async prove(
    execution: SceneGenerationExecution,
    effects: readonly DurableEffectRecord[],
    requireCompletion: boolean
  ): Promise<
    | {
        candidateSnapshotId: string
        settle: boolean
        record: DurableEffectRecord
      }
    | undefined
  > {
    const identity = this.identityOf(execution)
    const recorded = execution.candidateSnapshotId
    for (const effect of effects) {
      if (effect.operationId !== execution.operationId) throw new Error('副作用记录不属于当前操作')
      if (effect.status === 'unknown') throw new Error('副作用结果不明')
    }
    const inFlight = effects.filter((effect) => effect.status === 'started')
    if (inFlight.length > 1) throw new Error('存在多条未结算写入')
    if (inFlight.length === 1 && inFlight[0]!.kind !== 'fileWrite')
      throw new Error('未结算副作用不是候选写入')

    const current = await this.files.currentWorkspaceRevision(identity)
    let target: DurableEffectRecord
    let candidateSnapshotId: string
    let previousCandidate: string | undefined
    let settle = false
    if (inFlight.length === 1) {
      target = inFlight[0]!
      settle = true
      if (current === undefined) throw new Error('工作区没有已发布的新修订')
      // 修订已保存但执行记录尚未绑定候选：工作区引用就是本次写出的后写候选，
      // 执行记录里的候选是写前候选。只有两者不同时才存在这个子窗口。
      if (recorded !== undefined && current !== recorded) {
        candidateSnapshotId = current
        previousCandidate = recorded
      } else {
        candidateSnapshotId = recorded ?? current
      }
    } else if (requireCompletion) {
      if (recorded === undefined) throw new Error('读取边界缺少当前候选')
      if (current !== recorded) throw new Error('工作区修订与读取候选不一致')
      candidateSnapshotId = recorded
      const completed = this.completedTarget(effects, candidateSnapshotId)
      if (completed === undefined) throw new Error('缺少可证明当前候选的写入记录')
      target = completed
    } else if (recorded === undefined) {
      // 旧顺序在补完成回执之后才绑定候选：账本里已有 completed，执行记录仍停在写前状态。
      // 用工作区引用与完成记录的 candidateRevision 共同证明后写候选，不再补写回执。
      if (current === undefined) return undefined
      const completed = this.completedTarget(effects, current, false)
      if (completed === undefined) return undefined
      candidateSnapshotId = current
      target = completed
    } else {
      if (current === undefined) return undefined
      if (current !== recorded) {
        // 完成回执已写、执行记录仍停在写前候选：以工作区引用和完成记录共同证明后写候选。
        candidateSnapshotId = current
        previousCandidate = recorded
        const completed = this.completedTarget(effects, candidateSnapshotId, false)
        if (completed === undefined)
          throw new Error('工作区修订领先但缺少可证明的写入记录')
        target = completed
      } else {
        candidateSnapshotId = recorded
        const completed = this.completedTarget(effects, candidateSnapshotId, false)
        // 人工编辑或历史修订复核由普通恢复重新读取候选，不要求存在副作用记录。
        if (completed === undefined) return undefined
        target = completed
      }
    }

    const parsed = STEP_PATTERN.exec(target.stepId)
    if (!parsed) throw new Error('写入步骤标识不可识别')
    const targetMode = parsed[1] as 'generate' | 'repair'
    const targetIndex = Number(parsed[2])
    const tag = parsed[3]
    const records = new Map<string, DurableEffectRecord>()
    for (const effect of effects) {
      const match = STEP_PATTERN.exec(effect.stepId)
      if (!match) continue
      if ((match[3] ?? undefined) !== tag) continue
      const key = `${match[1]}-${Number(match[2])}`
      if (records.has(key)) throw new Error('同一轮存在多条写入记录')
      records.set(key, effect)
    }
    if (records.get(`${targetMode}-${targetIndex}`) !== target)
      throw new Error('写入步骤记录不一致')
    const targetFacts = await this.files.readOwnedRevision({
      ...identity,
      revisionId: candidateSnapshotId
    })
    if (targetFacts.parentRevisionIds.length > 1) throw new Error('候选修订存在多个父提交')
    const firstMode = await this.firstModeOf(
      identity,
      records,
      targetIndex,
      targetMode,
      targetFacts.parentRevisionIds[0]
    )
    let previous =
      targetIndex === 0
        ? (previousCandidate ??
          this.preCandidateFromParent(execution, targetFacts.parentRevisionIds[0]))
        : undefined
    if (previous !== undefined) await this.assertRevisionOwnership(execution, previous)

    const chain = new Set<string>()
    for (let index = 0; index < targetIndex; index += 1) {
      const mode = index === 0 ? firstMode : 'repair'
      const key = `${mode}-${index}`
      chain.add(key)
      const record = records.get(key)
      if (!record || record.kind !== 'fileWrite' || record.status !== 'completed')
        throw new Error('写入链缺少已完成的候选修订')
      const revisionId = record.candidateRevision
      if (revisionId === undefined) throw new Error('写入链缺少候选修订')
      const facts = await this.files.readOwnedRevision({ ...identity, revisionId })
      const parent = facts.parentRevisionIds[0]
      if (facts.parentRevisionIds.length > 1) throw new Error('候选修订存在多个父提交')
      if (index === 0 && targetIndex > 0) {
        previous = this.preCandidateFromParent(execution, parent)
        if (previous !== undefined) await this.assertRevisionOwnership(execution, previous)
      } else if ((parent ?? undefined) !== (previous ?? undefined)) {
        throw new Error('写入链修订父子关系不一致')
      }
      const expected = candidateInputDigest(mode, this.digestFacts(execution, previous))
      if (record.inputDigest !== expected) throw new Error('写入链输入摘要不匹配')
      previous = revisionId
    }
    chain.add(`${targetMode}-${targetIndex}`)
    const expected = candidateInputDigest(targetMode, this.digestFacts(execution, previous))
    if (target.inputDigest !== expected) throw new Error('目标写入输入摘要不匹配')
    const targetParent = targetFacts.parentRevisionIds[0]
    if (
      (targetParent ?? undefined) !== (previous ?? undefined) &&
      !(
        targetIndex === 0 &&
        targetParent !== undefined &&
        targetParent === execution.repairInputSnapshotId
      )
    )
      throw new Error('目标写入修订与输入链不一致')
    if (target.status === 'completed' && target.candidateRevision !== candidateSnapshotId)
      throw new Error('目标写入未产出当前候选')
    if (target.status === 'started' && target.candidateRevision !== undefined)
      throw new Error('未结算写入已声称候选修订')
    this.assertNoExtraWrites(effects, chain, tag, firstMode)
    if ((await this.files.currentWorkspaceRevision(identity)) !== candidateSnapshotId)
      throw new Error('工作区修订与当前候选不一致')
    await this.artifacts.verifyRevision(execution, candidateSnapshotId)
    return { candidateSnapshotId, settle, record: target }
  }

  /**
   * 写入前的工作区引用可能是本操作的修复来源物化修订；它不是候选事实，
   * 输入摘要按候选尚未出现计算，不能把它冒充为写前候选。
   */
  private preCandidateFromParent(
    execution: SceneGenerationExecution,
    parent: string | undefined
  ): string | undefined {
    return parent !== undefined && parent === execution.repairInputSnapshotId ? undefined : parent
  }

  /**
   * 写前候选必须属于本操作；唯一例外是分叉复制来的来源候选。
   * 该修订必须正是持久化分叉记录指向的来源候选，并由来源操作保存，不能用其它修订冒充。
   */
  private async assertRevisionOwnership(
    execution: SceneGenerationExecution,
    revisionId: string
  ): Promise<void> {
    try {
      await this.files.readOwnedRevision({ ...this.identityOf(execution), revisionId })
      return
    } catch (error) {
      if (await this.isForkSourceRevision(execution, revisionId)) return
      throw error
    }
  }

  /**
   * 分叉父修订必须由创建分叉时捕获的不可变来源证据独立证明：同一项目/场景/线程、
   * 不同新分支、来源操作与检查点一致，且该修订由来源操作发布并归属。
   * 持久 fork 字段只用于发起核对；来源继续推进或当前检查点消失都不参与判定。
   */
  private async isForkSourceRevision(
    execution: SceneGenerationExecution,
    revisionId: string
  ): Promise<boolean> {
    const fork = execution.fork
    if (!fork || fork.sourceOperationId === undefined || fork.candidateSnapshotId !== revisionId)
      return false
    if (!this.verifyForkSource) return false
    try {
      return await this.verifyForkSource(execution, revisionId)
    } catch {
      return false
    }
  }

  private completedTarget(
    effects: readonly DurableEffectRecord[],
    candidateSnapshotId: string,
    required = true
  ): DurableEffectRecord | undefined {
    const completed = effects.filter(
      (effect) =>
        effect.kind === 'fileWrite' &&
        effect.status === 'completed' &&
        effect.candidateRevision === candidateSnapshotId
    )
    if (completed.length > 1) throw new Error('多个步骤声称写入了同一候选')
    const target = completed[0]
    if (target === undefined && required) throw new Error('缺少可证明当前候选的写入记录')
    return target
  }

  private async firstModeOf(
    identity: WorkflowIdentity,
    records: ReadonlyMap<string, DurableEffectRecord>,
    targetIndex: number,
    targetMode: 'generate' | 'repair',
    targetParent: string | undefined
  ): Promise<'generate' | 'repair'> {
    if (targetIndex === 0) return targetMode
    const generate = records.get('generate-0')?.candidateRevision
    const repair = records.get('repair-0')?.candidateRevision
    if (generate === undefined && repair === undefined)
      throw new Error('写入链缺少首轮记录')
    if (generate === undefined) return 'repair'
    if (repair === undefined) return 'generate'
    // 同一操作可能先有 generate-0，再由后续运行写出 repair-0；第二轮修订的父提交
    // 唯一指向本次运行的首轮，不能按第一条存在记录猜测。
    let secondParent: string | undefined
    if (targetIndex === 1) {
      secondParent = targetParent
    } else {
      const secondRevision = records.get('repair-1')?.candidateRevision
      if (secondRevision === undefined) throw new Error('写入链缺少首轮之后的记录')
      const secondFacts = await this.files.readOwnedRevision({
        ...identity,
        revisionId: secondRevision
      })
      secondParent = secondFacts.parentRevisionIds[0]
    }
    if (secondParent === generate) return 'generate'
    if (secondParent === repair) return 'repair'
    throw new Error('无法判定首轮写入模式')
  }

  private assertNoExtraWrites(
    effects: readonly DurableEffectRecord[],
    chain: ReadonlySet<string>,
    tag: string | undefined,
    firstMode: 'generate' | 'repair'
  ): void {
    for (const effect of effects) {
      const match = STEP_PATTERN.exec(effect.stepId)
      if (!match) continue
      if ((match[3] ?? undefined) !== tag) continue
      const key = `${match[1]}-${Number(match[2])}`
      if (chain.has(key)) continue
      if (effect.status === 'failed') continue
      if (match[1] === 'generate' && firstMode === 'repair') continue
      throw new Error('写入边界之外存在额外副作用')
    }
  }

  private async settle(
    execution: SceneGenerationExecution,
    record: DurableEffectRecord,
    candidateSnapshotId: string
  ): Promise<void> {
    await finishCandidateEffect(
      this.stateRoot,
      execution,
      record.stepId,
      record.inputDigest,
      { candidateSnapshotId },
      record.questions ?? []
    )
  }

  /** 只保留本操作自己的当前工作区修订，不把其他操作或不可读修订当候选。 */
  private async retainedCandidate(
    execution: SceneGenerationExecution
  ): Promise<string | undefined> {
    const identity = this.identityOf(execution)
    try {
      const current = await this.files.currentWorkspaceRevision(identity)
      if (current === undefined) return undefined
      await this.files.readOwnedRevision({ ...identity, revisionId: current })
      return current
    } catch {
      return undefined
    }
  }

  private identityOf(execution: SceneGenerationExecution): WorkflowIdentity {
    return {
      projectId: assertWorkflowSegment(execution.projectId, 'projectId'),
      threadId: assertWorkflowSegment(execution.threadId, 'threadId'),
      operationId: assertWorkflowSegment(execution.operationId, 'operationId'),
      branchId: assertWorkflowSegment(execution.branchId, 'branchId')
    }
  }

  private digestFacts(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string | undefined
  ): CandidateInputFacts {
    return {
      inputSnapshot: execution.inputSnapshot,
      replies: execution.replies,
      ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId })
    }
  }
}
