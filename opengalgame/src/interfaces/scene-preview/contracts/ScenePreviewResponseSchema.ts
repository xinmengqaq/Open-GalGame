import { z } from 'zod'

import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type {
  DialogueSaveSettlementVO,
  PreviewUpdateVO,
  SaveDialogueChangesVO
} from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewErrorCode,
  PreviewRecoveryAction
} from '@application/scene-preview/vo/PreviewErrorVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewRuntimeEventVO,
  PreviewStageResultVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '@application/scene-preview/vo/ScenePreviewAvailabilityVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const identity = z.string().min(1).max(128)
const safeText = z.string().min(1).max(4000)
const message = z.string().max(200)
const generation = z.number().int().nonnegative().max(1_000_000)
const sequence = z.number().int().positive().max(1_000_000)
const previewErrorCodes = [
  'invalidRequest',
  'sceneUnavailable',
  'sceneArtifactMissing',
  'contentUnreadable',
  'sessionNotFound',
  'sessionClosed',
  'prepareAlreadyDone',
  'prepareFailed',
  'runtimeNotPrepared',
  'runtimeNotReady',
  'runtimeDisconnected',
  'commandTimeout',
  'staleRuntimeGeneration',
  'branchChoiceRequired',
  'locateNotReached',
  'positionCaptureFailed',
  'restoreFailed',
  'restoreTargetMissing',
  'restorePositionMismatch',
  'playbackCompleted',
  'contentBasisChanged',
  'contentLocked',
  'dialogueObjectInvalid',
  'saveRequestReused',
  'saveOutcomeUnknown',
  'saveNotConfirmed',
  'saveSettlementConflict',
  'previewUpdatePending',
  'engineCapabilityUnavailable'
] as const satisfies readonly PreviewErrorCode[]

type MissingPreviewErrorCode = Exclude<PreviewErrorCode, (typeof previewErrorCodes)[number]>
const previewErrorCodesMatch: MissingPreviewErrorCode extends never ? true : never = true
void previewErrorCodesMatch
const recoveryActions = [
  'retry',
  'retryPreviewUpdate',
  'querySettlement',
  'prepare',
  'replay',
  'reopen',
  'none'
] as const satisfies readonly PreviewRecoveryAction[]
const phase = z.enum(['preparing', 'playing', 'paused', 'completed', 'unknown'])
const position = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dialogue'), dialogueId: identity }),
  z.strictObject({ kind: z.literal('nonDialogue') }),
  z.strictObject({ kind: z.literal('completed') }),
  z.strictObject({ kind: z.literal('unknown') })
])
const contentBasis = z.strictObject({
  digest: identity,
  parserVersion: identity,
  engineVersion: identity
})
const previewError = z.strictObject({
  code: z.enum(previewErrorCodes),
  message,
  dialogueId: identity.optional(),
  recovery: z.enum(recoveryActions)
})
const runtimeState = z.strictObject({
  previewSessionId: identity,
  contentBasis,
  runtimeGeneration: generation,
  sequence,
  phase,
  position
})
const stageUrl = z
  .string()
  .url()
  .max(300)
  .refine((value) => !/[ \t\r\n]/.test(value))
const failedResult = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string()
})

const availability = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available') }),
  z.strictObject({
    status: z.literal('blocked'),
    reason: z.enum(['noArtifact', 'sceneUnavailable', 'readUnavailable']),
    message
  })
])
const session = z.strictObject({
  previewSessionId: identity,
  projectId: identity,
  sceneId: identity,
  sceneName: safeText,
  contentBasis,
  lockState: z.enum(['editable', 'locked', 'unknown']),
  dialogues: z
    .array(
      z.strictObject({
        dialogueId: identity,
        text: z.string().max(4000),
        editable: z.boolean()
      })
    )
    .max(1000),
  issues: z
    .array(
      z.strictObject({
        code: z.enum([
          'missingStableId',
          'duplicateStableId',
          'unresolvedStep',
          'lockMetadataMissing',
          'unsupportedStatement',
          'unsupportedParameter',
          'missingAsset',
          'invalidAssetReference'
        ]),
        message,
        dialogueId: identity.optional()
      })
    )
    .max(1000)
})
const stageResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), stage: runtimeState, stageUrl }),
  z.strictObject({ status: z.literal('failed'), failure: previewError })
])
const draftResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    dialogueId: identity,
    editRevision: generation,
    runtimeGeneration: generation,
    sequence
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum([
      'runtimeNotPrepared',
      'runtimeNotReady',
      'staleRuntimeGeneration',
      'dialogueNotMounted'
    ])
  })
])
const edit = z.strictObject({ dialogueId: identity, text: z.string().max(4000) })
const saveRequest = z.strictObject({
  projectId: identity,
  sceneId: identity,
  requestId: identity
})
const keptStage = runtimeState.extend({
  position: z.strictObject({ kind: z.literal('dialogue'), dialogueId: identity })
})
const previewUpdate = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('kept'), stage: keptStage }),
  z.strictObject({ status: z.literal('failed'), failure: previewError }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['stageNeverPrepared', 'runtimeNotReady', 'sessionClosed'])
  })
])
const saveResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('saved'),
    contentBasis,
    runtimeGeneration: generation,
    committedEdits: z.array(edit).max(1000),
    previewUpdate
  }),
  z.strictObject({
    status: z.literal('unchanged'),
    contentBasis,
    confirmedEdits: z.array(edit).max(1000)
  }),
  z.strictObject({
    status: z.literal('pendingVerification'),
    request: saveRequest,
    failure: previewError
  }),
  z.strictObject({ status: z.literal('rejected'), failure: previewError })
])
const settlementResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('saved'),
    contentBasis,
    committedEdits: z.array(edit).max(1000)
  }),
  z.strictObject({
    status: z.literal('unchanged'),
    contentBasis,
    confirmedEdits: z.array(edit).max(1000)
  }),
  z.strictObject({
    status: z.literal('pendingVerification'),
    request: saveRequest,
    failure: previewError
  }),
  z.strictObject({
    status: z.literal('notCommitted'),
    request: saveRequest,
    failure: previewError
  }),
  z.strictObject({ status: z.literal('conflict'), request: saveRequest, failure: previewError }),
  z.strictObject({ status: z.literal('notFound'), request: saveRequest })
])
const commandResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('confirmed'), stage: runtimeState }),
  z.strictObject({ status: z.literal('failed'), failure: previewError })
])
const candidateResult = z.strictObject({
  projectId: identity,
  sceneId: identity,
  sceneName: safeText,
  readOnly: z.literal(true),
  candidate: z.strictObject({
    previewSessionId: identity,
    candidateSnapshotId: identity,
    expiresAt: z.string().datetime()
  }),
  contentBasis,
  issues: z.array(z.strictObject({ message, assetName: safeText.optional() })).max(1000)
})
const runtimeEvent = z.discriminatedUnion('type', [
  runtimeState.extend({ type: z.literal('stage') }),
  z.strictObject({
    type: z.literal('failed'),
    previewSessionId: identity,
    contentBasis,
    runtimeGeneration: generation,
    sequence,
    failure: previewError,
    lastConfirmed: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('known'), phase, position }),
      z.strictObject({ kind: z.literal('unknown') })
    ])
  })
])
const candidateEvent = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.enum(['ready', 'stageFailed']),
    sequence,
    projectId: identity,
    sceneId: identity,
    previewSessionId: identity,
    candidateSnapshotId: identity,
    message: message.optional()
  }),
  z.strictObject({
    type: z.literal('invalidated'),
    sequence,
    projectId: identity,
    sceneId: identity,
    previewSessionId: identity,
    candidateSnapshotId: identity
  })
])

function success<T extends z.ZodType>(data: T): z.ZodType<AjaxResult<z.output<T>>> {
  return z.union([
    z.strictObject({ code: z.literal(ErrorCodes.success), msg: z.string().max(200), data }),
    failedResult
  ])
}

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseScenePreviewAvailabilityResult(
  value: unknown
): AjaxResult<ScenePreviewAvailabilityVO> | null {
  return parseResult(success(availability), value)
}

export function parseScenePreviewSessionResult(
  value: unknown
): AjaxResult<ScenePreviewSessionVO> | null {
  return parseResult(success(session), value)
}

export function parsePreviewStageResult(value: unknown): AjaxResult<PreviewStageResultVO> | null {
  return parseResult(success(stageResult), value)
}

export function parsePreviewDraftResult(value: unknown): AjaxResult<PreviewDraftResultVO> | null {
  return parseResult(success(draftResult), value)
}

export function parseSaveDialogueChangesResult(
  value: unknown
): AjaxResult<SaveDialogueChangesVO> | null {
  return parseResult(success(saveResult), value)
}

export function parseDialogueSaveSettlementResult(
  value: unknown
): AjaxResult<DialogueSaveSettlementVO> | null {
  return parseResult(success(settlementResult), value)
}

export function parsePreviewUpdateResult(value: unknown): AjaxResult<PreviewUpdateVO> | null {
  return parseResult(success(previewUpdate), value)
}

export function parsePreviewCommandResult(
  value: unknown
): AjaxResult<PreviewCommandResultVO> | null {
  return parseResult(success(commandResult), value)
}

export function parseScenePreviewNullResult(value: unknown): AjaxResult<null> | null {
  return parseResult(success(z.null()), value)
}

export function parseCandidatePreviewResult(value: unknown): AjaxResult<CandidatePreviewVO> | null {
  return parseResult(success(candidateResult), value)
}

export function parsePreviewRuntimeEvent(value: unknown): PreviewRuntimeEventVO | null {
  return parseResult(runtimeEvent, value)
}

export type CandidatePreviewEventVO = z.output<typeof candidateEvent>

export function parseCandidatePreviewEvent(value: unknown): CandidatePreviewEventVO | null {
  return parseResult(candidateEvent, value)
}

export function parseCandidatePreviewEventResult(
  value: unknown
): AjaxResult<CandidatePreviewEventVO | null> | null {
  return parseResult(success(candidateEvent.nullable()), value)
}
