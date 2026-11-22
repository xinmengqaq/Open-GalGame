import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  decideDurableEffectRecovery,
  readDurableEffects
} from '@infrastructure/workflow/execution/durableEffect'
import {
  candidateInputDigest,
  candidateReplyStepTag
} from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import type { CandidateWriteReplay } from './PiSceneGenerationTypes'

/**
 * 核对一次运行的持久写入链：轮次必须从 0 连续、摘要按上一修订衔接、结果必须可证实。
 * 任何 started/unknown 或边界之外的额外写入都说明有在途或迟到结果，不能当安全暂停/恢复。
 * @returns 链上最后一轮写出的候选修订；没有写入时返回起始候选。
 * @throws {SceneGenerationWriteOutcomeUnknown} 结果无法归属或存在额外写入。
 * @throws {AppException} 输入摘要或记录种类与当前运行不一致。
 */
export async function inspectWriteEffects(
  stateRoot: string,
  execution: SceneGenerationExecution,
  options: {
    readonly passes: number
    readonly firstMode: 'generate' | 'repair'
    readonly baseCandidateSnapshotId?: string
    readonly tag?: string
  }
): Promise<{ candidateSnapshotId?: string }> {
  const effects = await readDurableEffects(stateRoot, execution)
  if (effects.some((effect) => effect.status === 'started'))
    throw new SceneGenerationWriteOutcomeUnknown('候选写入回执不明，已保留记录待核对')
  const pattern = /^(generate|repair)-(\d+)(?:-([0-9a-f]{16}))?$/u
  // 轮号只在同一模式内唯一：接受后的 repair-0 与首次 generate-0 是两次运行，
  // 不能按相同数字合并，否则会把旧写入误认成本次边界之后的额外写入。
  const records = new Map<string, (typeof effects)[number]>()
  for (const effect of effects) {
    const match = pattern.exec(effect.stepId)
    if (!match) continue
    if ((match[3] ?? undefined) !== options.tag) continue
    const step = `${match[1]}-${Number(match[2])}`
    if (records.has(step))
      throw new SceneGenerationWriteOutcomeUnknown('同一轮存在多条写入记录，已保留记录待核对')
    records.set(step, effect)
  }
  let candidateSnapshotId = options.baseCandidateSnapshotId
  for (let index = 0; index < options.passes; index += 1) {
    const mode = index === 0 ? options.firstMode : 'repair'
    const record = records.get(`${mode}-${index}`)
    if (!record)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '暂停边界缺少已完成的写入记录'
      })
    if (record.status !== 'completed' || record.kind !== 'fileWrite' || !record.candidateRevision)
      throw new SceneGenerationWriteOutcomeUnknown('候选写入结果无法证实，已保留记录待核对')
    // 第一轮不能把当前（后续轮次才出现的）候选带进历史输入摘要。
    const digestFacts = { ...execution }
    if (candidateSnapshotId === undefined) delete digestFacts.candidateSnapshotId
    else digestFacts.candidateSnapshotId = candidateSnapshotId
    const expected = candidateInputDigest(mode, digestFacts)
    if (record.inputDigest !== expected)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '写入副作用与暂停输入不匹配，已停止恢复'
      })
    candidateSnapshotId = record.candidateRevision
  }
  for (const [step, record] of records) {
    const match = pattern.exec(step)!
    const mode = match[1]
    const index = Number(match[2])
    if (mode === (index === 0 ? options.firstMode : 'repair') && index < options.passes) continue
    // 修复运行之前同一操作的首次生成写入属于旧运行，不是本边界之后的额外写入。
    if (mode === 'generate' && options.firstMode === 'repair') continue
    if (record.status === 'completed' || record.status === 'started' || record.status === 'unknown')
      throw new SceneGenerationWriteOutcomeUnknown('暂停边界之后存在额外写入，已保留记录待核对')
  }
  return candidateSnapshotId === undefined ? {} : { candidateSnapshotId }
}

/**
 * 读取同一回复已完成的写入轮次并核对输入链。
 * completed 必须带可靠结果；整组回答的 started 只有在当前候选快照可归属时才可补结算。
 * 其它状态、额外轮次或输入不匹配一律停止，不重跑模型，也不改写候选。
 * @returns 已完成的轮数、最后一轮不可变修订，以及待补的 started 结算。
 * @throws {AppException} 写入回执不明、归属不一致或与当前输入不兼容。
 */
export async function replayReplyEffects(
  stateRoot: string,
  execution: SceneGenerationExecution,
  replyKind: 'revise' | 'answers'
): Promise<CandidateWriteReplay> {
  const pending = execution.pendingReply
  if (!pending || pending.reply.kind !== replyKind) return { passes: 0 }
  const tag = candidateReplyStepTag(pending.replyId)
  const effects = await readDurableEffects(stateRoot, execution)
  const relevant = effects.filter(
    (effect) =>
      effect.operationId === execution.operationId &&
      effect.stepId.endsWith(`-${tag}`) &&
      (effect.stepId.startsWith('repair-') ||
        (replyKind === 'answers' && effect.stepId.startsWith('generate-')))
  )
  const unknownMessage =
    replyKind === 'answers'
      ? '整组回答的写入回执不明，已保留记录待核对'
      : '上一轮修改的副作用结果不明，已停止自动重放'
  const mismatchMessage =
    replyKind === 'answers'
      ? '写入副作用与当前输入不匹配，已停止恢复'
      : '修改副作用与当前输入不兼容，已停止恢复'
  let passes = 0
  let candidateSnapshotId =
    replyKind === 'revise'
      ? (pending.candidateSnapshotId ?? execution.candidateSnapshotId)
      : undefined
  let settlement: CandidateWriteReplay['settlement']
  for (;;) {
    const mode: 'generate' | 'repair' =
      replyKind === 'answers' && passes === 0 ? 'generate' : 'repair'
    const stepId = `${mode}-${passes}-${tag}`
    const record = relevant.find((effect) => effect.stepId === stepId)
    if (!record) break
    // 显式覆盖旧候选身份：整组回答首轮的写入摘要必须按候选尚未出现计算。
    const expected = candidateInputDigest(mode, { ...execution, candidateSnapshotId })
    if (record.inputDigest !== expected)
      throw new AppException({ code: ErrorCodes.operationConflict, msg: mismatchMessage })
    if (replyKind === 'answers' && record.kind !== 'fileWrite')
      throw new AppException({ code: ErrorCodes.operationConflict, msg: unknownMessage })
    if (record.status === 'completed') {
      const recovery = decideDurableEffectRecovery(record, () => ({ outcome: 'unknown' }))
      if (recovery.action !== 'skip' || recovery.candidateRevision === undefined)
        throw new AppException({ code: ErrorCodes.operationConflict, msg: unknownMessage })
      candidateSnapshotId = recovery.candidateRevision
      passes += 1
      continue
    }
    // 写入意图之后、完成记录之前崩溃：只有当前执行记录已绑定一个不同于上一轮的候选修订，
    // 才能证明该修订是本步写出的结果；随后只补一次 completed，不重写文件。
    // 无法归属的 started 不猜结果，抛待核对型错误，由应用恢复边界保留回答、候选与账本。
    if (
      replyKind === 'answers' &&
      record.status === 'started' &&
      record.kind === 'fileWrite' &&
      execution.candidateSnapshotId !== undefined &&
      execution.candidateSnapshotId !== candidateSnapshotId
    ) {
      candidateSnapshotId = execution.candidateSnapshotId
      settlement = { stepId, inputDigest: record.inputDigest }
      passes += 1
      break
    }
    if (replyKind === 'answers' && record.status === 'started' && record.kind === 'fileWrite')
      throw new SceneGenerationWriteOutcomeUnknown('候选写入回执不明，已保留记录待核对')
    throw new AppException({ code: ErrorCodes.operationConflict, msg: unknownMessage })
  }
  if (relevant.length > passes)
    throw new AppException({ code: ErrorCodes.operationConflict, msg: unknownMessage })
  // 整组回答只能在“当前候选正好是这次写入的结果”时恢复；不能用已完成记录替换别的候选。
  if (
    replyKind === 'answers' &&
    passes > 0 &&
    execution.candidateSnapshotId !== candidateSnapshotId
  )
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '候选修订与本次写入不一致，已停止恢复'
    })
  return {
    passes,
    ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
    ...(settlement === undefined ? {} : { settlement })
  }
}
