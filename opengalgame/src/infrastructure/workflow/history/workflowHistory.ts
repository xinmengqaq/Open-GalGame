import type { CheckpointListOptions } from '@langchain/langgraph-checkpoint'

import type { DurableEffectRecord } from '../DurableEffectRecord'
import { WorkflowError } from '../WorkflowError'
import { langGraphThreadKey, type WorkflowIdentity } from '../WorkflowIdentity'
import type { ReadOnlyGenerationCheckpointStore } from '../checkpoints/ReadOnlyCheckpointStore'

export interface WorkflowHistoryEntry {
  checkpointId: string
  parentCheckpointId?: string
  createdAt?: string
}

export interface ContinuationAssessment {
  continuable: boolean
  reason?: string
}

/**
 * 读取历史检查点。只读取磁盘上的旧检查点，不写盘，也不修改正式工程。
 * @throws {WorkflowError | AppException} 身份不合法，或检查点损坏、不兼容。
 */
export async function readWorkflowHistory(
  store: ReadOnlyGenerationCheckpointStore,
  identity: WorkflowIdentity,
  options?: CheckpointListOptions
): Promise<WorkflowHistoryEntry[]> {
  const entries: WorkflowHistoryEntry[] = []
  const history = store.list(
    { configurable: { thread_id: langGraphThreadKey(identity), checkpoint_ns: '' } },
    options
  )
  for await (const tuple of history) {
    const checkpointId = tuple.config.configurable?.checkpoint_id
    if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
      throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
    }
    const parent = tuple.parentConfig?.configurable?.checkpoint_id
    entries.push({
      checkpointId,
      ...(typeof tuple.checkpoint.ts === 'string' && tuple.checkpoint.ts.length > 0
        ? { createdAt: tuple.checkpoint.ts }
        : {}),
      ...(typeof parent === 'string' && parent.length > 0 ? { parentCheckpointId: parent } : {})
    })
  }
  return entries
}

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
