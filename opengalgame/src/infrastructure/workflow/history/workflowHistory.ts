import type { RunnableConfig } from '@langchain/core/runnables'
import type { StateSnapshot } from '@langchain/langgraph'
import type { CheckpointListOptions } from '@langchain/langgraph-checkpoint'

import type { DurableEffectRecord } from '../DurableEffectRecord'
import { WorkflowError } from '../WorkflowError'
import { createForkIdentity, langGraphThreadKey, type WorkflowIdentity } from '../WorkflowIdentity'
import type { FileCheckpointSaver } from '../checkpoints/FileCheckpointSaver'

export interface WorkflowHistoryEntry {
  checkpointId: string
  parentCheckpointId?: string
  next: readonly string[]
  createdAt?: string
}

export interface ContinuationAssessment {
  continuable: boolean
  reason?: string
}

/**
 * 读取历史检查点。只调用库的历史查询，不写盘，也不修改正式工程。
 * @throws {WorkflowError | AppException} 身份不合法，或检查点损坏、不兼容。
 */
export async function readWorkflowHistory(
  graph: {
    getStateHistory(
      config: RunnableConfig,
      options?: CheckpointListOptions
    ): AsyncIterable<StateSnapshot>
  },
  identity: WorkflowIdentity,
  options?: { limit?: number }
): Promise<WorkflowHistoryEntry[]> {
  const entries: WorkflowHistoryEntry[] = []
  const history = graph.getStateHistory(
    { configurable: { thread_id: langGraphThreadKey(identity), checkpoint_ns: '' } },
    options
  )
  for await (const snapshot of history) {
    const checkpointId = snapshot.config.configurable?.checkpoint_id
    if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
      throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
    }
    const parent = snapshot.parentConfig?.configurable?.checkpoint_id
    entries.push({
      checkpointId,
      next: snapshot.next,
      ...(typeof snapshot.createdAt === 'string' ? { createdAt: snapshot.createdAt } : {}),
      ...(typeof parent === 'string' && parent.length > 0 ? { parentCheckpointId: parent } : {})
    })
  }
  return entries
}

/**
 * 沿父检查点找到当前分支的起点。不修复缺失的历史。
 * @returns 没有父检查点的起点标识。
 * @throws {WorkflowError} 没有可读取的历史，或父链中断。
 */
export async function confirmBranchStart(
  graph: {
    getStateHistory(
      config: RunnableConfig,
      options?: CheckpointListOptions
    ): AsyncIterable<StateSnapshot>
  },
  identity: WorkflowIdentity
): Promise<{ checkpointId: string }> {
  const history = await readWorkflowHistory(graph, identity)
  if (history.length === 0) {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  const byId = new Map(history.map((entry) => [entry.checkpointId, entry]))
  let current = history[0]
  if (!current) {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  const seen = new Set<string>()
  while (current.parentCheckpointId) {
    if (seen.has(current.checkpointId)) {
      throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
    }
    seen.add(current.checkpointId)
    const parent = byId.get(current.parentCheckpointId)
    if (!parent) {
      throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
    }
    current = parent
  }
  return { checkpointId: current.checkpointId }
}

/**
 * 判断历史检查点能否继续。已写入但没有候选修订时不能继续。
 * @returns 可否在重建候选工作区后继续，以及不能继续的原因。
 */
export function assessContinuation(
  effects: readonly DurableEffectRecord[]
): ContinuationAssessment {
  const writes = effects.filter((effect) => effect.kind === 'fileWrite' || effect.kind === 'commit')
  if (writes.length === 0) return { continuable: true }
  if (writes.some((effect) => !effect.candidateRevision)) {
    return { continuable: false, reason: '已发生写入但缺少候选修订，不能继续' }
  }
  if (writes.some((effect) => effect.status !== 'completed' || !effect.resultDigest)) {
    return { continuable: false, reason: '副作用结果尚未确认，不能继续' }
  }
  return { continuable: true }
}

/**
 * 从历史点分叉。保留原分支，生成新的分支和操作身份。
 * 没有文件副作用时复制检查点链，供调用方重建候选工作区后继续。
 * @throws {WorkflowError | AppException} 历史点不存在，或复制检查点失败。
 */
export async function forkWorkflowBranch(input: {
  graph: {
    getStateHistory(
      config: RunnableConfig,
      options?: CheckpointListOptions
    ): AsyncIterable<StateSnapshot>
  }
  saver: FileCheckpointSaver
  source: WorkflowIdentity
  checkpointId: string
  effects: readonly DurableEffectRecord[]
  branchId?: string
  operationId?: string
}): Promise<{ identity: WorkflowIdentity; continuable: boolean; reason?: string }> {
  const history = await readWorkflowHistory(input.graph, input.source)
  if (!history.some((entry) => entry.checkpointId === input.checkpointId)) {
    throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
  }
  const assessment = assessContinuation(input.effects)
  const identity = createForkIdentity(input.source, input.checkpointId, {
    branchId: input.branchId,
    operationId: input.operationId
  })
  if (!assessment.continuable) {
    return { identity, continuable: false, reason: assessment.reason }
  }
  await copyCheckpointChain(input.saver, input.source, identity, input.checkpointId)
  return { identity, continuable: true }
}

/**
 * 把历史点及其父链复制到新分支。先读完再写，避免写到一半才发现父检查点缺失。
 * @throws {WorkflowError} 父链不完整或写入失败。
 */
async function copyCheckpointChain(
  saver: FileCheckpointSaver,
  source: WorkflowIdentity,
  target: WorkflowIdentity,
  checkpointId: string
): Promise<void> {
  const sourceKey = langGraphThreadKey(source)
  const targetKey = langGraphThreadKey(target)
  const chain: Array<{
    checkpointId: string
    tuple: NonNullable<Awaited<ReturnType<FileCheckpointSaver['getTuple']>>>
  }> = []
  let current: string | undefined = checkpointId
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current)) {
      throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
    }
    seen.add(current)
    const tuple = await saver.getTuple({
      configurable: { thread_id: sourceKey, checkpoint_ns: '', checkpoint_id: current }
    })
    if (!tuple) {
      throw new WorkflowError({ category: 'recoveryBasisMissing', msg: '缺少可恢复依据' })
    }
    chain.push({ checkpointId: current, tuple })
    current = tuple.parentConfig?.configurable?.checkpoint_id
  }
  for (const item of chain.reverse()) {
    const parentId = item.tuple.parentConfig?.configurable?.checkpoint_id
    await saver.put(
      {
        configurable: {
          thread_id: targetKey,
          checkpoint_ns: '',
          ...(parentId ? { checkpoint_id: parentId } : {})
        }
      },
      item.tuple.checkpoint,
      item.tuple.metadata ?? { source: 'fork', step: -1, parents: {} },
      item.tuple.checkpoint.channel_versions
    )
    const grouped = new Map<string, Array<[string, unknown]>>()
    for (const [taskId, channel, value] of item.tuple.pendingWrites ?? []) {
      const writes = grouped.get(taskId) ?? []
      writes.push([channel, value])
      grouped.set(taskId, writes)
    }
    for (const [taskId, writes] of grouped) {
      await saver.putWrites(
        {
          configurable: {
            thread_id: targetKey,
            checkpoint_ns: '',
            checkpoint_id: item.checkpointId
          }
        },
        writes,
        taskId
      )
    }
    const association = await saver.readAssociation(source, item.checkpointId)
    if (association) {
      await saver.associate(target, item.checkpointId, {
        ...association,
        operationId: target.operationId
      })
    }
  }
}
