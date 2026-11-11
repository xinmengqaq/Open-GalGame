import { z } from 'zod'

import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const identity = z.string().min(1).max(128)
const stateSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'committing',
  'interrupted',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled'
])
const stageSchema = z.enum([
  'readingInput',
  'generating',
  'validating',
  'waitingReview',
  'committing',
  'completed',
  'failed',
  'cancelled',
  'paused'
])
const failedResultSchema = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string()
})
const renderStatusSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  operationId: identity,
  threadId: identity,
  branchId: identity,
  checkpointId: identity.optional(),
  state: stateSchema,
  stage: stageSchema,
  stageMessage: z.string().max(200),
  attempt: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  updatedAt: z.string().min(1).optional(),
  canPause: z.boolean(),
  canResume: z.boolean(),
  canCancel: z.boolean(),
  resumeReason: z.string().max(200).optional(),
  inputSummary: z.strictObject({
    canvasId: identity,
    arrangementVersion: identity,
    documentCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(),
    promptCount: z.number().int().nonnegative(),
    fieldBindingCount: z.number().int().nonnegative(),
    relationCount: z.number().int().nonnegative(),
    confirmedControlCount: z.number().int().nonnegative(),
    details: z
      .strictObject({
        documents: z.array(z.string().max(80)).max(12).optional(),
        prompts: z.array(z.string().max(80)).max(12).optional(),
        relations: z.array(z.string().max(80)).max(12).optional()
      })
      .optional()
  }),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    tokenLimit: z.number().int().nonnegative().nullable(),
    modelCalls: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional()
  }),
  activity: z
    .strictObject({
      kind: z.enum(['model', 'tool', 'waitingModel']),
      lastActivityAt: z.string().datetime(),
      lastToolName: z.string().max(64).optional(),
      noNewInformationStreak: z.number().int().nonnegative().optional()
    })
    .optional(),
  recentProgress: z
    .array(
      z.strictObject({
        sequence: z.number().int().nonnegative(),
        createdAt: z.string().datetime(),
        stage: stageSchema,
        message: z.string().max(200)
      })
    )
    .max(6)
    .optional(),
  interaction: z
    .strictObject({
      interactionId: identity,
      checkpointId: identity,
      kind: z.enum(['decision', 'review', 'clarification', 'correction']),
      question: z.string().max(4000).optional(),
      detail: z.string().max(4000).optional(),
      message: z.string().max(4000),
      options: z
        .array(
          z.strictObject({
            id: identity,
            label: z.string().max(200),
            description: z.string().max(2000)
          })
        )
        .max(20),
      questions: z
        .array(
          z.strictObject({
            questionId: identity,
            prompt: z.string().max(500),
            detail: z.string().max(2000).optional(),
            options: z
              .array(
                z.strictObject({
                  id: identity,
                  label: z.string().max(200),
                  description: z.string().max(2000)
                })
              )
              .length(3)
          })
        )
        .min(1)
        .max(4)
        .optional(),
      allowedReplies: z
        .array(z.enum(['select', 'answers', 'clarify', 'accept', 'revise', 'discard']))
        .max(6),
      candidateSnapshotId: identity.optional()
    })
    .optional(),
  answeredQuestions: z
    .array(
      z.strictObject({
        questionId: identity,
        prompt: z.string().max(500),
        optionId: identity,
        label: z.string().max(200),
        description: z.string().max(2000),
        body: z.string().max(2000).optional()
      })
    )
    .max(64)
    .optional(),
  userMessages: z
    .array(
      z.strictObject({
        kind: z.enum(['revise', 'clarify']),
        body: z.string().max(2000),
        round: z.number().int().positive().max(64)
      })
    )
    .max(64)
    .optional(),
  mode: z.enum(['generate', 'repair', 'validate']).optional(),
  repairSource: z
    .strictObject({
      operationId: identity,
      threadId: identity,
      branchId: identity,
      checkpointId: identity,
      candidateSnapshotId: identity
    })
    .optional(),
  candidateSnapshotId: identity.optional(),
  previewAuthorization: z.enum(['readOnly', 'unavailable']).optional(),
  knownIssues: z
    .array(
      z.strictObject({
        code: z.enum([
          'missing-entry',
          'unknown-command',
          'unsupported-dialogue',
          'invalid-argument',
          'scene-jump',
          'option-edge',
          'condition',
          'unauthorized-asset',
          'missing-asset',
          'external-asset',
          'invalid-path',
          'purpose-mismatch',
          'identity-mismatch',
          'implicit-speaker',
          'automatic-effect-before-end',
          'missing-background',
          'missing-character',
          'scene-locked',
          'lock-unknown',
          'baseline-changed',
          'baseline-unknown'
        ]),
        message: z.string().max(200),
        sequence: z.number().int().nonnegative().optional(),
        correctable: z.boolean(),
        requiresHumanDecision: z.boolean(),
        reference: z.string().max(500).optional(),
        line: z.number().int().positive().optional(),
        nearestReference: z.string().max(500).optional(),
        nearestAssetName: z.string().max(500).optional()
      })
    )
    .max(100)
    .optional(),
  previewAvailable: z.boolean(),
  result: z.strictObject({ commitId: identity }).optional(),
  failure: z
    .strictObject({
      code: z.number().int(),
      message: z.string().max(200),
      reason: z
        .enum([
          'noInformationGain',
          'missingCandidateWrite',
          'outputTruncated',
          'missingStructuredResult',
          'structuredOutput',
          'modelFailure',
          'modelRejected',
          'modelAccess',
          'contextOverflow',
          'correctionsExhausted'
        ])
        .optional(),
      failureClass: z
        .enum([
          'inputInvalid',
          'blocked',
          'modelTransient',
          'modelAuth',
          'modelRejected',
          'contextOverflow',
          'outputContract',
          'noProgress',
          'correctionsExhausted',
          'internal'
        ])
        .optional(),
      nextActions: z
        .array(
          z.enum([
            'retryOperation',
            'retryRepair',
            'regenerate',
            'checkConnection',
            'reviseRequirement',
            'reduceInput',
            'viewCandidate',
            'resume',
            'verifyTask',
            'returnToCanvas',
            'viewInputSummary',
            'discard'
          ])
        )
        .max(12)
        .optional(),
      reference: z
        .string()
        .regex(/^[0-9a-f]{12}$/)
        .optional(),
      unverified: z.boolean().optional(),
      legacy: z.boolean().optional(),
      candidateSnapshotId: identity.optional(),
      previewAuthorization: z.enum(['readOnly', 'unavailable']).optional()
    })
    .optional()
})
const historySummarySchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  operationId: identity,
  threadId: identity,
  branchId: identity,
  checkpointId: identity,
  boundary: z.enum([
    'started',
    'candidateCreated',
    'waitingDecision',
    'waitingReview',
    'paused',
    'committed',
    'failed',
    'cancelled'
  ]),
  stage: stageSchema,
  message: z.string().max(200),
  createdAt: z.string().datetime(),
  candidateSnapshotId: identity.optional(),
  commitId: identity.optional(),
  failureReason: z
    .enum([
      'noInformationGain',
      'missingCandidateWrite',
      'outputTruncated',
      'missingStructuredResult',
      'structuredOutput',
      'modelFailure',
      'modelRejected',
      'modelAccess',
      'contextOverflow',
      'correctionsExhausted'
    ])
    .optional(),
  legacy: z.boolean().optional()
})
const previewSchema = z.strictObject({
  previewSessionId: identity,
  candidateSnapshotId: identity,
  url: z.string().url().max(300),
  expiresAt: z.string().datetime()
})

function success<T extends z.ZodType>(data: T): z.ZodType<AjaxResult<z.output<T>>> {
  return z.union([
    z.strictObject({ code: z.literal(ErrorCodes.success), msg: z.string(), data }),
    failedResultSchema
  ])
}

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 校验渲染状态。路径、脚本和内部差异不能通过。 */
export function parseSceneGenerationStatusResult(
  value: unknown
): AjaxResult<SceneGenerationRenderStatusVO> | null {
  return parseResult(success(renderStatusSchema), value)
}

/** 校验场景级 AI 历史。作品历史不走这里。 */
export function parseSceneGenerationHistoryResult(
  value: unknown
): AjaxResult<readonly SceneGenerationHistorySummaryVO[]> | null {
  return parseResult(success(z.array(historySummarySchema).max(100)), value)
}

/** 校验单条安全检查点摘要。内部路径和脚本正文不能通过。 */
export function parseSceneGenerationCheckpointResult(
  value: unknown
): AjaxResult<SceneGenerationHistorySummaryVO> | null {
  return parseResult(success(historySummarySchema), value)
}

/** 校验只读预览会话。成功响应只含会话身份和 URL。 */
export function parseSceneGenerationPreviewResult(
  value: unknown
): AjaxResult<SceneGenerationCandidatePreviewVO> | null {
  return parseResult(success(previewSchema), value)
}

/** 校验无内容的成功响应。 */
export function parseSceneGenerationNullResult(value: unknown): AjaxResult<null> | null {
  return parseResult(success(z.null()), value)
}
