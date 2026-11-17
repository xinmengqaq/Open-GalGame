import { createHash } from 'node:crypto'
import type {
  SceneGenerationCandidateRevisionRecord,
  SceneGenerationExecution,
  SceneGenerationRuntime
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { WebGalGenerationStateValue } from '../WebGalGenerationState'

/** 用本次真实输入、回复、候选身份和模式生成副作用输入摘要；字段集合属于恢复契约。 */
export function candidateInputDigest(
  mode: WebGalGenerationStateValue['mode'],
  execution: SceneGenerationExecution
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

/** 先保存不可变修订，再记录当前候选身份；两步失败保留原始错误，成功后才返回修订。 */
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
