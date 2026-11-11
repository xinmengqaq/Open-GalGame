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

/** 修复重跑只接受来源身份和确认正文，拒绝路径与检查点内部。 */
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

export const resumeSceneGenerationSchema = z.strictObject({
  ...branch,
  checkpointId: identity,
  candidateSnapshotId: identity.optional()
})

export const listSceneGenerationHistorySchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  cursor: identity.optional(),
  limit: z.number().int().min(1).max(100)
})

/** 最近一次生成只按场景身份读取；不暴露操作、线程或检查点内部。 */
export const latestSceneGenerationSchema = z.strictObject({
  projectId: identity,
  sceneId: identity
})

export const readSceneGenerationCheckpointSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  threadId: identity,
  branchId: identity,
  checkpointId: identity
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
