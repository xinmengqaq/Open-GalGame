import { createHash } from 'node:crypto'
import type {
  SceneGenerationCandidateRevisionRecord,
  SceneGenerationExecution,
  SceneGenerationRuntime
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/** 生成模式属于运行事实，不再依赖旧图状态类型。 */
export type CandidateWriteMode = 'generate' | 'repair' | 'validate' | 'finalize'

/** 回复标识只用于区分同一操作的副作用步骤，不把请求原文写入路径。 */
export function candidateReplyStepTag(replyId: string): string {
  return createHash('sha256').update(replyId).digest('hex').slice(0, 16)
}

/** 输入摘要只消费不可变输入、回复与写入前候选身份。 */
export interface CandidateInputFacts {
  readonly inputSnapshot: SceneGenerationExecution['inputSnapshot']
  readonly replies: SceneGenerationExecution['replies']
  readonly candidateSnapshotId?: string
}

export function candidateInputDigest(
  mode: CandidateWriteMode,
  execution: CandidateInputFacts
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputs: execution.inputSnapshot,
        replies: execution.replies,
        candidate: execution.candidateSnapshotId,
        mode
      })
    )
    .digest('hex')
}

export async function saveCandidateRevision(input: {
  artifacts: Pick<SceneArtifactGateway, 'saveCandidateRevision'>
  runtime: Pick<SceneGenerationRuntime, 'recordCandidateRevision'>
  execution: SceneGenerationExecution
  agentError: unknown
}): Promise<SceneGenerationCandidateRevisionRecord> {
  let revision: SceneGenerationCandidateRevisionRecord
  try {
    revision = await input.artifacts.saveCandidateRevision(input.execution)
  } catch (saveError) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '候选修订保存失败',
      cause: input.agentError ? new AggregateError([input.agentError, saveError]) : saveError
    })
  }
  try {
    await input.runtime.recordCandidateRevision({
      candidateSnapshotId: revision.candidateSnapshotId
    })
  } catch (recordError) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '候选修订记录保存失败',
      cause: recordError
    })
  }
  return revision
}
