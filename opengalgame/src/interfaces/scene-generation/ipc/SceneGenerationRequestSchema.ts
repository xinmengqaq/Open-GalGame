import { z } from 'zod'

const identity = z.string().trim().min(1).max(128)
const text = z.string().max(4000)
const scope = {
  projectId: identity,
  sceneId: identity,
  operationId: identity
}
const branch = {
  ...scope,
  threadId: identity,
  branchId: identity
}
const confirmedControlSchema = z.strictObject({
  kind: z.enum(['sceneJump', 'option', 'condition']),
  content: text,
  inputId: identity
})
const policySchema = z.strictObject({
  maxCorrections: z.number().int().nonnegative().max(100)
})
const replySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['accept', 'discard']) }),
  z.strictObject({ kind: z.enum(['clarify', 'revise']), body: text.min(1) }),
  z.strictObject({ kind: z.literal('select'), optionId: identity, body: text.optional() }),
  z.strictObject({
    kind: z.literal('answers'),
    answers: z
      .array(
        z.strictObject({
          questionId: identity,
          optionId: identity,
          body: text.optional()
        })
      )
      .min(1)
      .max(4)
  })
])

export const startSceneGenerationSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  canvasId: identity,
  confirmedControls: z.array(confirmedControlSchema).max(100),
  policy: policySchema
})

export const retrySceneGenerationRepairSchema = startSceneGenerationSchema.extend({
  repair: z.strictObject({
    sourceOperationId: identity,
    sourceThreadId: identity,
    sourceBranchId: identity,
    sourceCheckpointId: identity,
    candidateSnapshotId: identity,
    instruction: text.min(1)
  })
})

export const sceneGenerationScopeSchema = z.strictObject(scope)

export const sceneGenerationProgressSchema = z.strictObject(branch)

export const replySceneGenerationSchema = z.strictObject({
  ...branch,
  interactionId: identity,
  checkpointId: identity,
  candidateSnapshotId: identity.optional(),
  replyId: identity,
  reply: replySchema
})

export const resumeSceneGenerationSchema = z.union([
  z.strictObject({
    ...branch,
    checkpointId: identity,
    candidateSnapshotId: identity.optional()
  }),
  z.strictObject({
    ...branch,
    recovery: z.literal('unfinished')
  }),
  z.strictObject({
    ...branch,
    recovery: z.literal('cleanup')
  }),
  z.strictObject({
    ...branch,
    recovery: z.literal('verify')
  })
])

export const listSceneGenerationHistorySchema = z
  .strictObject({
    projectId: identity,
    sceneId: identity,
    cursor: identity.optional(),
    limit: z.number().int().min(1).max(100),
    /** 需要作者处理的操作专用游标；与历史 cursor 互斥。 */
    unfinishedCursor: identity.optional(),
    unfinishedLimit: z.number().int().min(1).max(100).optional()
  })
  .refine((request) => request.cursor === undefined || request.unfinishedCursor === undefined, {
    message: '历史游标与需要处理的操作游标不能同时使用',
    path: ['unfinishedCursor']
  })

export const latestSceneGenerationSchema = z.strictObject({
  projectId: identity,
  sceneId: identity
})

/** 未完成操作只按场景读取；不接收操作或线程身份，避免定向探测其它场景。 */
export const listUnfinishedSceneGenerationsSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  cursor: identity.optional(),
  limit: z.number().int().min(1).max(100).optional()
})

/** 待核对结果只按当前操作五元身份重新读取，不接受检查点、候选或路径。 */
export const verifySceneGenerationUnknownSchema = z.strictObject(branch)

export const readSceneGenerationCheckpointSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  threadId: identity,
  branchId: identity,
  checkpointId: identity
})

/** 历史分叉只接受来源分支、检查点和已批准策略；新操作身份由应用层生成。 */
export const forkSceneGenerationSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  threadId: identity,
  branchId: identity,
  checkpointId: identity,
  policy: policySchema
})

export const openSceneGenerationPreviewSchema = z.strictObject({
  ...branch,
  checkpointId: identity,
  candidateSnapshotId: identity
})

export const closeSceneGenerationPreviewSchema = z.strictObject({
  ...scope,
  previewSessionId: identity
})
