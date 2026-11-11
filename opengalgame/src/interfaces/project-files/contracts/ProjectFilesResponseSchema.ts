import { z } from 'zod'

import type { ProjectFileOperationSettlementVO } from '@application/project-files/vo/ProjectFileOperationVO'
import type { ProjectFilesInspectionVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const failedResultSchema = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string()
})

const fileAssetKinds = ['image', 'audio', 'video'] as const
const summarySchema = z.union([
  z.strictObject({
    sourceId: z.string(),
    name: z.string(),
    readable: z.boolean(),
    parentFolderId: z.string().nullable(),
    contentKind: z.literal('text'),
    textKind: z.literal('document')
  }),
  z.strictObject({
    sourceId: z.string(),
    name: z.string(),
    readable: z.boolean(),
    parentFolderId: z.string().nullable(),
    contentKind: z.enum(fileAssetKinds)
  })
])
const folderSchema = z.strictObject({
  folderId: z.string(),
  parentFolderId: z.string().nullable(),
  name: z.string()
})
const catalogSchema = z.strictObject({
  projectId: z.string(),
  catalogVersion: z.string(),
  folders: z.array(folderSchema),
  sources: z.array(summarySchema)
})
const deletionPlanSchema = z.strictObject({
  folderId: z.string(),
  name: z.string(),
  catalogVersion: z.string(),
  folderCount: z.number(),
  fileCount: z.number(),
  deletionVersion: z.string()
})
const sourceSchema = z.union([
  z.strictObject({
    sourceId: z.string(),
    version: z.string(),
    contentKind: z.literal('text'),
    textKind: z.literal('document'),
    title: z.string(),
    body: z.string(),
    topics: z.array(z.string()),
    importInfo: z.strictObject({ format: z.enum(['markdown', 'plainText']) })
  }),
  z.strictObject({
    sourceId: z.string(),
    version: z.string(),
    contentKind: z.enum(fileAssetKinds),
    name: z.string(),
    fileId: z.string(),
    description: z.string()
  })
])
const inspectionResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.strictObject({
      projectId: z.string(),
      inputSourceFormatSupported: z.boolean(),
      canvasArrangementFormatSupported: z.boolean(),
      diagnostics: z.array(
        z.strictObject({
          objectId: z.string(),
          kind: z.enum(['missing', 'damaged', 'duplicateIdentity', 'brokenReference'])
        })
      )
    })
  }),
  failedResultSchema
])
const summaryResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: catalogSchema
  }),
  failedResultSchema
])
const snapshotResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.strictObject({
      projectId: z.string(),
      readVersion: z.string(),
      sources: z.array(sourceSchema)
    })
  }),
  failedResultSchema
])
const importResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.strictObject({
      importedFiles: z.array(summarySchema),
      failedFiles: z.array(z.strictObject({ fileName: z.string(), message: z.string() }))
    })
  }),
  failedResultSchema
])
const chosenFilesResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.array(z.string()).nullable()
  }),
  failedResultSchema
])
const nullResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.null()
  }),
  failedResultSchema
])
const droppedFilePathResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.string().min(1)
  }),
  failedResultSchema
])
const folderResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: folderSchema
  }),
  failedResultSchema
])
const deletionPlanResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: deletionPlanSchema
  }),
  failedResultSchema
])
const summaryValueResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: summarySchema
  }),
  failedResultSchema
])
const sourceValueResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: sourceSchema
  }),
  failedResultSchema
])
const mediaResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.strictObject({
      sourceId: z.string(),
      contentKind: z.enum(fileAssetKinds),
      fileName: z.string(),
      mediaType: z.string().min(1),
      bytes: z.instanceof(Uint8Array)
    })
  }),
  failedResultSchema
])
/**
 * 校验跨进程响应。结构不符时返回 null，不补字段。
 * @returns 校验后的响应；结构不符时为 null。
 */
function parseProjectFilesResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectFilesInspectionResult(
  value: unknown
): AjaxResult<ProjectFilesInspectionVO> | null {
  return parseProjectFilesResult(inspectionResultSchema, value)
}

/**
 * @returns 校验后的媒体字节；结构不符时为 null。
 */
export function parseProjectMediaResult(value: unknown): AjaxResult<ProjectMediaVO> | null {
  return parseProjectFilesResult(mediaResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectInputSourceListResult(
  value: unknown
): AjaxResult<ProjectInputCatalogVO> | null {
  return parseProjectFilesResult(summaryResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectFolderResult(value: unknown): AjaxResult<ProjectFolderVO> | null {
  return parseProjectFilesResult(folderResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectFolderDeletionPlanResult(
  value: unknown
): AjaxResult<ProjectFolderDeletionPlanVO> | null {
  return parseProjectFilesResult(deletionPlanResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectInputSourcesSnapshotResult(
  value: unknown
): AjaxResult<ProjectInputSourcesSnapshotVO> | null {
  return parseProjectFilesResult(snapshotResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectInputSourceResult(
  value: unknown
): AjaxResult<ProjectInputSourceVO> | null {
  return parseProjectFilesResult(sourceValueResultSchema, value)
}

/**
 * 校验文件选择响应。取消时 data 为 null。
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseChosenProjectFilesResult(
  value: unknown
): AjaxResult<readonly string[] | null> | null {
  return parseProjectFilesResult(chosenFilesResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseImportProjectFilesResult(
  value: unknown
): AjaxResult<ImportProjectFilesVO> | null {
  return parseProjectFilesResult(importResultSchema, value)
}

/**
 * 校验打开或删除的空成功响应。
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectFileNullResult(value: unknown): AjaxResult<null> | null {
  return parseProjectFilesResult(nullResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseRenamedProjectFileResult(
  value: unknown
): AjaxResult<ProjectInputSourceSummaryVO> | null {
  return parseProjectFilesResult(summaryValueResultSchema, value)
}

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseDroppedFilePathResult(value: unknown): AjaxResult<string> | null {
  return parseProjectFilesResult(droppedFilePathResultSchema, value)
}

const operationSettlementSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.strictObject({
      operationId: z.string(),
      settlement: z.enum(['committed', 'notCommitted', 'unsettled'])
    })
  }),
  failedResultSchema
])

/**
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseProjectFileOperationResult(
  value: unknown
): AjaxResult<ProjectFileOperationSettlementVO> | null {
  return parseProjectFilesResult(operationSettlementSchema, value)
}
