import { z } from 'zod'

import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationForkVO,
  SceneGenerationHistoryDetailVO,
  SceneGenerationHistoryPageVO,
  SceneGenerationRenderStatusVO,
  SceneGenerationVerificationResultVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { failureResultSchema } from '../../contracts/FailureResultSchema'

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
  canResumeUnfinished: z.boolean().optional(),
  cleanupPending: z.boolean().optional(),
  canRetryCleanup: z.boolean().optional(),
  canVerifyResult: z.boolean().optional(),
  blocksNewGeneration: z.boolean().optional(),
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
    .optional()
})
const previewSchema = z.strictObject({
  previewSessionId: identity,
  candidateSnapshotId: identity,
  url: z.string().url().max(300),
  expiresAt: z.string().datetime()
})
/** 单条历史详情只多出后端证明的分叉资格和用户可读原因。 */
const historyDetailSchema = historySummarySchema.extend({
  canFork: z.boolean(),
  forkReason: z.string().max(200).optional()
})
/** 分叉响应只含新操作安全状态和来源展示摘要；不接受内部恢复种子。 */
const forkResultSchema = z.strictObject({
  status: renderStatusSchema,
  source: z.strictObject({
    summary: z.string().max(200),
    createdAt: z.string().datetime().optional()
  })
})

/** 待核对结果只含核对结论、固定安全文案和当前状态；不暴露回执、账本或路径。 */
const sceneGenerationVerificationResultSchema = z.strictObject({
  outcome: z.enum(['candidateWritten', 'committed', 'stillPending']),
  message: z.string().max(200),
  status: renderStatusSchema
})

/**
 * 历史页与需要作者处理的操作页各有独立游标，最多各 100 条；
 * 未完成页游标只在确有更早条目时返回，不与历史 checkpointId 混用。
 */
const historyPageSchema = z.strictObject({
  items: z.array(historySummarySchema).max(100),
  unfinished: z.array(renderStatusSchema).max(100),
  unfinishedNextCursor: identity.optional()
})

function success<T extends z.ZodType>(data: T): z.ZodType<AjaxResult<z.output<T>>> {
  return z.union([
    z.strictObject({ code: z.literal(ErrorCodes.success), msg: z.string(), data }),
    failureResultSchema
  ])
}

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseSceneGenerationStatusResult(
  value: unknown
): AjaxResult<SceneGenerationRenderStatusVO> | null {
  return parseResult(success(renderStatusSchema), value)
}

/** 校验场景级 AI 历史页。作品历史不走这里；未完成操作不是历史条目。 */
export function parseSceneGenerationHistoryResult(
  value: unknown
): AjaxResult<SceneGenerationHistoryPageVO> | null {
  return parseResult(success(historyPageSchema), value)
}

/** 校验待核对结果；页面只读取 outcome、安全文案和当前状态。 */
export function parseSceneGenerationVerificationResult(
  value: unknown
): AjaxResult<SceneGenerationVerificationResultVO> | null {
  return parseResult(success(sceneGenerationVerificationResultSchema), value)
}

export function parseSceneGenerationCheckpointResult(
  value: unknown
): AjaxResult<SceneGenerationHistoryDetailVO> | null {
  return parseResult(success(historyDetailSchema), value)
}

/** 校验分叉创建结果。内部路径、检查点差异和模型原文不能通过。 */
export function parseSceneGenerationForkResult(
  value: unknown
): AjaxResult<SceneGenerationForkVO> | null {
  return parseResult(success(forkResultSchema), value)
}

export function parseSceneGenerationPreviewResult(
  value: unknown
): AjaxResult<SceneGenerationCandidatePreviewVO> | null {
  return parseResult(success(previewSchema), value)
}

export function parseSceneGenerationNullResult(value: unknown): AjaxResult<null> | null {
  return parseResult(success(z.null()), value)
}
