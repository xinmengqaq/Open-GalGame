import { z } from 'zod'

import type { DialogueTextEdit } from '@domain/scene-preview/models/DialogueTextEdit'
import { AppException } from '@common/errors/AppException'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import {
  parseVersionValue,
  readVersionValue,
  versionDocumentPath,
  writeVersionValue
} from '@infrastructure/project-versioning/versionStore'

export const PREVIEW_SAVE_DIRECTORY = ['opengalgame', 'scene-preview-saves']

const saveRecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  projectId: z.string().min(1),
  sceneId: z.string().min(1),
  requestId: z.string().min(1),
  callerOperationId: z.string().regex(OPERATION_ID_PATTERN),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  baseDigest: z.string().min(1),
  parserVersion: z.string().min(1),
  engineVersion: z.string().min(1),
  editsSnapshot: z.string().min(1),
  committedEdits: z.array(z.strictObject({ dialogueId: z.string().min(1), text: z.string() })),
  relativePath: z.string(),
  revisionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  contentDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  refusal: z
    .enum(['contentLocked', 'contentBasisChanged', 'dialogueObjectInvalid', 'sessionClosed'])
    .optional()
})

export type PreviewSaveRecord = z.infer<typeof saveRecordSchema>

export async function readPreviewSaveRecord(
  projectRoot: string,
  callerOperationId: string
): Promise<PreviewSaveRecord | null> {
  const value = await readVersionValue(await previewSavePath(projectRoot, callerOperationId))
  if (value === null) return null
  const record = parseVersionValue(saveRecordSchema, value)
  if (record.callerOperationId !== callerOperationId) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '版本记录无法读取'
    })
  }
  return record
}

export async function writePreviewSaveRecord(
  projectRoot: string,
  record: PreviewSaveRecord
): Promise<void> {
  parseVersionValue(saveRecordSchema, record)
  await writeVersionValue(await previewSavePath(projectRoot, record.callerOperationId), record)
}

export function samePreviewPayload(
  record: PreviewSaveRecord,
  expected: {
    projectId: string
    sceneId: string
    requestId: string
    baseDigest: string
    parserVersion: string
    engineVersion: string
    editsSnapshot: string
    committedEdits: readonly DialogueTextEdit[]
    relativePath: string
    revisionDigest: string
  }
): boolean {
  return (
    record.projectId === expected.projectId &&
    record.sceneId === expected.sceneId &&
    record.requestId === expected.requestId &&
    record.baseDigest === expected.baseDigest &&
    record.parserVersion === expected.parserVersion &&
    record.engineVersion === expected.engineVersion &&
    record.editsSnapshot === expected.editsSnapshot &&
    record.relativePath === expected.relativePath &&
    record.revisionDigest === expected.revisionDigest &&
    JSON.stringify(record.committedEdits) === JSON.stringify(expected.committedEdits)
  )
}

async function previewSavePath(projectRoot: string, callerOperationId: string): Promise<string> {
  if (!OPERATION_ID_PATTERN.test(callerOperationId)) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      msg: '版本记录无法读取'
    })
  }
  return versionDocumentPath(projectRoot, PREVIEW_SAVE_DIRECTORY, `${callerOperationId}.json`)
}
