import { z } from 'zod'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { assetCategoryOfPurpose } from '@domain/scenes/models/SceneAssetReference'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 当前执行文档版本。版本 7 以 step 取代 phase，旧 phase 由迁移映射为 step 或省略；版本 6 增加失败分类与下一步动作；
 * 版本 4 缺少问题组；版本 1 保留旧输入快照，版本 2、3 缺少记录时间。
 * repairContext 是版本 6 内的纯可选增量，旧记录缺字段保持缺失，不升版本。
 * 缺失素材诊断字段（reference/line/nearest*）同样是版本 7 内的纯可选增量，旧记录缺字段保持缺失。
 */
export const SCENE_GENERATION_EXECUTION_DOCUMENT_VERSION = 7

const text = z.string().min(1)
/** 生成侧校验报告；执行记录与修复上下文共用。 */
const validationReportSchema = z.object({
  issues: z
    .array(
      z.object({
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
        message: z.string().max(500),
        sequence: z.number().int().nonnegative().optional(),
        reference: z.string().max(500).optional(),
        line: z.number().int().positive().optional(),
        nearestReference: z.string().max(500).optional(),
        nearestAssetName: z.string().max(500).optional(),
        nearestAssetPath: z.string().max(500).optional(),
        correctable: z.boolean(),
        requiresHumanDecision: z.boolean()
      })
    )
    .max(100)
})
const failureReasonSchema = z.enum([
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
const failureClassSchema = z.enum([
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
const identity = {
  projectId: text,
  sceneId: text,
  operationId: text,
  threadId: text,
  branchId: text
}
const questionOption = z.object({ id: text, label: text, description: text })
const question = z.object({
  questionId: text,
  prompt: text,
  detail: z.string().optional(),
  options: z.array(questionOption).length(3)
})
const questionAnswer = z.object({
  questionId: text,
  optionId: text,
  body: z.string().optional()
})
const answerFact = z.object({
  questionId: text,
  prompt: text,
  optionId: text,
  label: text,
  description: text,
  body: text.optional()
})
const reply = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept') }),
  z.object({ kind: z.literal('discard') }),
  z.object({ kind: z.literal('clarify'), body: text }),
  z.object({ kind: z.literal('revise'), body: text }),
  z.object({ kind: z.literal('select'), optionId: text, body: z.string().optional() }),
  z.object({ kind: z.literal('answers'), answers: z.array(questionAnswer).min(1).max(4) })
])
const acceptedReply = z.object({
  projectId: text,
  sceneId: text,
  operationId: text,
  threadId: text,
  branchId: text,
  interactionId: text,
  checkpointId: text,
  candidateSnapshotId: text.optional(),
  replyId: text,
  reply,
  selection: z
    .object({
      optionId: text,
      label: text,
      description: z.string(),
      body: text.optional()
    })
    .optional(),
  selections: z.array(answerFact).min(1).max(4).optional()
})
const usage = z.object({
  characterId: z.string().optional(),
  locationId: z.string().optional(),
  spokenLine: z.string().optional(),
  targetIds: z.array(text)
})
const confirmedControl = z.object({
  kind: z.enum(['sceneJump', 'option', 'condition']),
  content: text,
  inputId: text
})
const selection = z.object({
  canvasId: text,
  confirmedControls: z.array(confirmedControl)
})
const promptScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scene') }),
  z.object({ kind: z.literal('cards'), cardIds: z.array(text) }),
  z.object({ kind: z.literal('relation'), relationId: text })
])
const promptReference = z.object({
  cardId: text,
  kind: z.enum(['document', 'image', 'audio', 'video', 'animation', 'effect']),
  displayName: text
})

const defaultRelation = z.enum([
  'actsOn',
  'accompanies',
  'voices',
  'depicts',
  'constrains',
  'sameSubject',
  'associated'
])
const policy = z.object({
  maxCorrections: z.number().int().nonnegative()
})
const checkpoint = z.object({
  projectId: text,
  sceneId: text,
  threadId: text,
  branchId: text,
  checkpointId: text
})
export const sourceLocationSchema = z.object({
  projectId: text,
  sceneId: text,
  projectRoot: text,
  sceneDirectory: text,
  entryFile: text
})
const operationState = z.enum([
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
/** 业务步骤：只描述进行到哪一步，终态以 state 为权威，不携带业务 step。 */
const operationStep = z.enum([
  'preparing',
  'generating',
  'reading',
  'validating',
  'correcting',
  'converting',
  'committing',
  'rollingBack'
])

/** 旧输入快照仍要保留的操作身份。不补当前输入字段。 */
export const legacyOperationFactSchema = z.object({
  projectId: text,
  sceneId: text,
  operationId: text,
  threadId: text,
  branchId: text,
  fingerprint: text,
  state: operationState
})
export type LegacyOperationFact = z.infer<typeof legacyOperationFactSchema>

const assetCategory = z.enum(['image', 'audio', 'video'])
/** 版本 6 之前的执行记录只写用途；读取时换算为类别，写回不再保留。 */
const legacyAssetPurpose = z.enum([
  'background',
  'cg',
  'characterImage',
  'avatar',
  'music',
  'soundEffect',
  'voice',
  'video'
])

export const inputsSchema = z.object({
  canvasId: text,
  arrangementVersion: text,
  assets: z.array(
    z
      .object({
        assetId: text,
        sourceId: text,
        name: text,
        relativePath: text,
        category: assetCategory.optional(),
        purpose: legacyAssetPurpose.optional(),
        description: z.string(),
        usage
      })
      .transform((asset, ctx) => {
        const category =
          asset.category ??
          (asset.purpose === undefined ? undefined : assetCategoryOfPurpose(asset.purpose))
        if (category === undefined) {
          ctx.addIssue({ code: 'custom', message: '生成输入素材缺少类别', path: ['category'] })
          return z.NEVER
        }
        return {
          assetId: asset.assetId,
          sourceId: asset.sourceId,
          name: asset.name,
          relativePath: asset.relativePath,
          category,
          description: asset.description,
          usage: asset.usage
        }
      })
  ),
  documents: z.array(
    z.object({
      id: text,
      sourceId: text,
      title: text,
      summary: z.string(),
      body: text,
      topics: z.array(text),
      usage
    })
  ),
  prompts: z.array(
    z.object({
      id: text,
      title: text,
      body: text,
      scopes: z.array(promptScope).min(1),
      references: z.array(promptReference).optional().default([]),
      usage
    })
  ),
  fieldBindings: z.array(
    z.object({
      cardId: text,
      kind: z.enum(['animation', 'effect']),
      command: z.string().nullable(),
      name: z.string().nullable(),
      usage
    })
  ),
  relations: z.array(
    z.object({
      relationId: text,
      fromCardId: text,
      toCardId: text,
      defaultRelation,
      specificName: z.string(),
      record: z.union([
        z.object({ kind: z.literal('document'), cardId: text, sourceId: text }),
        z.object({ kind: z.literal('prompt'), cardId: text }),
        z.null()
      ])
    })
  ),
  confirmedControls: z.array(confirmedControl)
})
const preview = z.object({
  entryFile: text,
  files: z.array(text),
  parserVersion: text,
  commandLocations: z.array(
    z.object({
      sequence: z.number(),
      filePath: text,
      line: z.number(),
      engineSentenceIndex: z.number()
    })
  ),
  assetLocations: z.array(z.object({ assetId: text, relativePath: text, sequence: z.number() })),
  validationReport: z.object({
    issues: z.array(
      z.object({
        code: text,
        message: text,
        sequence: z.number().optional(),
        reference: z.string().max(500).optional(),
        line: z.number().int().positive().optional(),
        nearestReference: z.string().max(500).optional(),
        nearestAssetName: z.string().max(500).optional(),
        nearestAssetPath: z.string().max(500).optional(),
        correctable: z.boolean(),
        requiresHumanDecision: z.boolean()
      })
    )
  })
})
export const executionDocumentSchema = z.object({
  ...identity,
  fingerprint: text,
  source: sourceLocationSchema,
  inputSnapshot: inputsSchema,
  policy,
  reviewCandidate: z.boolean(),
  baseline: z.object({
    commitId: text,
    affectedFiles: z.array(z.object({ relativePath: text, digest: text.optional() })),
    lockState: z.enum(['locked', 'unlocked', 'unknown'])
  }),
  state: operationState,
  step: operationStep.optional(),
  attempt: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  budget: z.object({
    correctionsUsed: z.number().nonnegative(),
    modelCallsUsed: z.number().nonnegative(),
    toolCallsUsed: z.number().nonnegative(),
    activeElapsedMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    tokenLimit: z.number().int().positive().nullable().optional()
  }),
  live: z
    .object({
      activity: z.enum(['model', 'tool', 'waitingModel']),
      lastActivityAt: text,
      lastToolName: text.optional(),
      noNewInformationStreak: z.number().int().nonnegative().optional()
    })
    .optional(),
  createdAt: text.optional(),
  updatedAt: text.optional(),
  mode: z.enum(['generate', 'repair', 'validate']).optional(),
  repairSource: z
    .object({
      operationId: text,
      threadId: text,
      branchId: text,
      checkpointId: text,
      candidateSnapshotId: text
    })
    .optional(),
  repairInputSnapshotId: text.optional(),
  /** 修复来源上下文为可选增量，不升版本；旧记录缺失时保持缺失。 */
  repairContext: z
    .object({
      sourceOperationId: text,
      sourceThreadId: text,
      sourceBranchId: text,
      sourceCheckpointId: text,
      sourceCandidateSnapshotId: text,
      candidatePath: text,
      instruction: text,
      summary: z.string(),
      confirmedReplies: z
        .array(z.object({ kind: z.enum(['revise', 'clarify']), body: text }))
        .max(64),
      unresolvedIssues: z.array(z.string().max(500)).max(100),
      validationReport: validationReportSchema.optional(),
      failureClass: failureClassSchema.optional(),
      failureReason: failureReasonSchema.optional(),
      failureMessage: z.string().max(2000).optional()
    })
    .optional(),
  checkpointId: text.optional(),
  candidateSnapshotId: text.optional(),
  interaction: z
    .object({
      interactionId: text,
      checkpointId: text,
      kind: z.enum(['decision', 'clarification', 'correction', 'review']),
      question: z.string().optional(),
      detail: z.string().optional(),
      message: text,
      options: z.array(z.object({ id: text, label: text, description: z.string().optional() })),
      questions: z.array(question).min(1).max(4).optional(),
      allowedReplies: z.array(
        z.enum(['accept', 'discard', 'clarify', 'revise', 'select', 'answers'])
      ),
      candidateSnapshotId: text.optional()
    })
    .optional(),
  replies: z.array(acceptedReply),
  pendingReply: acceptedReply.optional(),
  fork: checkpoint.optional(),
  forkRequest: checkpoint
    .extend({
      operationId: text,
      inputChanges: selection.optional(),
      decisionChanges: z.array(z.object({ interactionId: text, reply })).optional(),
      policy,
      reviewCandidate: z.boolean().optional()
    })
    .optional(),
  preview: preview.optional(),
  result: z.object({ ...identity, commitId: text, preview }).optional(),
  failure: z
    .object({
      code: z.number(),
      message: text,
      reason: failureReasonSchema.optional(),
      failureClass: failureClassSchema.optional(),
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
        .min(1)
        .optional(),
      category: z
        .enum([
          'sdk',
          'streaming',
          'context',
          'tool',
          'structured-output',
          'unknown',
          'no-progress',
          'completion',
          'auth',
          'request',
          'output-truncated',
          'missing-structured-result'
        ])
        .optional(),
      httpStatus: z.number().int().optional(),
      causeName: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
        .optional(),
      diagnosticRef: z
        .string()
        .regex(/^[0-9a-f]{12}$/)
        .optional(),
      candidateSnapshotId: text.optional(),
      previewAuthorization: z.enum(['readOnly', 'unavailable']).optional()
    })
    .optional(),
  rollbackCommitId: text.optional(),
  workspaceCleanupPending: z.boolean().optional(),
  requiresCleanup: z.boolean().optional(),
  cancellationRequested: z.boolean().optional(),
  interruptReason: z.enum(['paused', 'candidateConflict', 'commitUnknown']).optional(),
  pauseRequested: z.boolean().optional(),
  timeline: z
    .array(
      z.object({
        entryId: text,
        sequence: z.number().int().nonnegative(),
        createdAt: text,
        kind: z.enum(['stage', 'interaction', 'decision', 'preview', 'failure']),
        stage: z.enum([
          'readingInput',
          'generating',
          'validating',
          'waitingReview',
          'committing',
          'completed',
          'failed',
          'cancelled',
          'paused'
        ]),
        message: text,
        interactionId: text.optional(),
        candidateSnapshotId: text.optional()
      })
    )
    .max(64)
    .optional(),
  artifactValidation: validationReportSchema.optional(),
  resumeReason: z.string().optional()
})
export type SceneGenerationExecutionDocument = z.infer<typeof executionDocumentSchema>

/** 在持久化信任边界校验并仅保留约定字段，排除凭据和运行对象。 */
export function executionFromDocument(value: unknown): SceneGenerationExecution {
  const parsed = executionDocumentSchema.safeParse(migrateExecutionDocument(value))
  if (!parsed.success)
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '场景生成执行事实格式不兼容或不完整',
      cause: parsed.error
    })
  return parsed.data
}

/**
 * 给旧格式补可追溯的记录时间和关键时间线。
 * 没有持久时间事实时不估算，并保持旧记录不可按当前格式继续。
 */
export function migrateExecutionDocument(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { phase: legacyPhase, ...record } = value as Record<string, unknown>
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : undefined
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : createdAt
  const timeline = Array.isArray(record.timeline) ? record.timeline : []
  const step = typeof record.step === 'string' ? record.step : migratedStep(legacyPhase)
  const migratedTimeline =
    timeline.length > 0 || updatedAt === undefined
      ? record.timeline
      : [
          {
            entryId: `${String(record.operationId)}:migrated`,
            sequence: typeof record.sequence === 'number' ? record.sequence : 0,
            createdAt: updatedAt,
            kind: record.failure || record.interruptReason ? 'failure' : 'stage',
            stage: migratedStage(record.state),
            message: '已恢复此前保存的生成记录'
          }
        ]
  return {
    ...record,
    ...(step === undefined ? {} : { step }),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(migratedTimeline === undefined ? {} : { timeline: migratedTimeline })
  }
}

/** 旧记录的 phase 只用于迁移：业务步骤一一对应，终态或等待阶段不携带业务 step。 */
function migratedStep(phase: unknown): string | undefined {
  if (typeof phase !== 'string') return undefined
  if (
    phase === 'waiting' ||
    phase === 'completed' ||
    phase === 'failed' ||
    phase === 'cancelled'
  )
    return undefined
  return phase === 'preparing' ||
    phase === 'generating' ||
    phase === 'reading' ||
    phase === 'validating' ||
    phase === 'correcting' ||
    phase === 'converting' ||
    phase === 'committing' ||
    phase === 'rollingBack'
    ? phase
    : undefined
}

function migratedStage(state: unknown): string {
  if (state === 'succeeded') return 'completed'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'cancelled'
  if (state === 'interrupted') return 'paused'
  if (state === 'waiting') return 'waitingReview'
  if (state === 'committing') return 'committing'
  return 'generating'
}
