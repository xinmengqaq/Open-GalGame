import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import {
  readOperationRecord,
  type OperationRecord
} from '@infrastructure/git/transaction/OperationRecord'
import { decodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema
} from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import {
  PROJECT_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema as legacyV3DocumentSchema
} from '@infrastructure/scene-canvas/migration/legacy/documents/LegacySceneCanvasArrangementDocument'
import {
  SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION,
  sceneCanvasArrangementV4DocumentSchema
} from '@infrastructure/scene-canvas/migration/legacy/documents/SceneCanvasArrangementV4Document'
import { planCanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/canvasArrangementMigrationPlan'
import {
  executionDocumentSchema,
  type SceneGenerationExecutionDocument
} from '@infrastructure/scene-generation/execution/SceneGenerationExecutionDocument'
import {
  legacyOperationFactSchema,
  migrateExecutionDocument,
  type LegacyOperationFact
} from '@infrastructure/scene-generation/execution/LegacyExecutionRecordDocument'

type CanvasIdentity = {
  projectId: string | null
  sceneKey: string
  canvasKey: string
}

type CanvasClassificationDetails = {
  projectId: string | null
  sceneId: string | null
  canvasId: string | null
  cards: number | null
  relations: number | null
}

type CanvasClassification = {
  formatVersion: number | null
  classification: 'current' | 'legacy' | 'unreadable'
  productReadable: boolean
  identityMatchesPath: boolean
  details?: CanvasClassificationDetails
  document?: unknown
  error?: string
}

type ExecutionRecordBase = {
  operationId: string | null
  sceneId: string | null
  threadId: string | null
  branchId: string | null
  state: string | null
  hasCreatedAt: boolean
  hasUpdatedAt: boolean
}

type ExecutionRecordClassification =
  | (ExecutionRecordBase & {
      classification: 'current'
      resumable: null
      value: SceneGenerationExecutionDocument
    })
  | (ExecutionRecordBase & {
      classification: 'legacy'
      resumable: false
      fact: LegacyOperationFact
    })
  | (ExecutionRecordBase & {
      classification: 'unreadable'
      resumable: false
      error: string
    })

type ExecutionEnvelopeClassification = {
  formatVersion: number | null
  classification: 'current' | 'legacy' | 'unreadable'
  records: ExecutionRecordClassification[]
  error?: string
}

type OperationBytesClassification =
  | { kind: 'current'; record: OperationRecord; raw: unknown }
  | { kind: 'unreadable'; raw: unknown; error: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function classifyCanvas(
  value: unknown,
  identity: CanvasIdentity
): CanvasClassification {
  const formatVersion =
    isObject(value) && typeof value.formatVersion === 'number' ? value.formatVersion : null
  let parsed: { success: true; data: unknown } | { success: false } = { success: false }
  let classification: 'current' | 'legacy' | 'unreadable' = 'unreadable'
  let productReadable = false
  if (formatVersion === SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION) {
    parsed = sceneCanvasArrangementDocumentSchema.safeParse(value)
    classification = parsed.success ? 'current' : 'unreadable'
    productReadable = true
  } else if (formatVersion === SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION) {
    parsed = sceneCanvasArrangementV4DocumentSchema.safeParse(value)
    classification = parsed.success ? 'legacy' : 'unreadable'
  } else if (formatVersion === PROJECT_ARRANGEMENT_FORMAT_VERSION) {
    parsed = legacyV3DocumentSchema.safeParse(value)
    classification = parsed.success ? 'legacy' : 'unreadable'
  }

  if (!parsed.success) {
    return {
      formatVersion,
      classification: 'unreadable',
      productReadable,
      identityMatchesPath: false,
      error:
        formatVersion === null
          ? '画布缺少 formatVersion'
          : `画布 v${formatVersion} 不满足生产 schema`
    }
  }

  const sceneId = decodeStorageKey(identity.sceneKey)
  const canvasId = decodeStorageKey(identity.canvasKey)
  const document = parsed.data as {
    projectId?: unknown
    sceneId?: unknown
    canvasId?: unknown
    cards?: unknown
    relations?: unknown
  }
  const identityMatchesPath =
    identity.projectId !== null &&
    document.projectId === identity.projectId &&
    sceneId !== null &&
    document.sceneId === sceneId &&
    canvasId !== null &&
    document.canvasId === canvasId
  return {
    formatVersion,
    classification: identityMatchesPath ? classification : 'unreadable',
    productReadable,
    identityMatchesPath,
    details: {
      projectId: typeof document.projectId === 'string' ? document.projectId : null,
      sceneId: typeof document.sceneId === 'string' ? document.sceneId : null,
      canvasId: typeof document.canvasId === 'string' ? document.canvasId : null,
      cards: Array.isArray(document.cards) ? document.cards.length : null,
      relations: Array.isArray(document.relations) ? document.relations.length : null
    },
    document: parsed.data,
    ...(identityMatchesPath ? {} : { error: '画布身份与路径不一致或工程身份缺失' })
  }
}

function classifyExecutionRecord(
  value: unknown,
  projectId: string
): ExecutionRecordClassification {
  const raw = isObject(value) ? value : {}
  const base = {
    operationId: typeof raw.operationId === 'string' ? raw.operationId : null,
    sceneId: typeof raw.sceneId === 'string' ? raw.sceneId : null,
    threadId: typeof raw.threadId === 'string' ? raw.threadId : null,
    branchId: typeof raw.branchId === 'string' ? raw.branchId : null,
    state: typeof raw.state === 'string' ? raw.state : null,
    hasCreatedAt: typeof raw.createdAt === 'string',
    hasUpdatedAt: typeof raw.updatedAt === 'string'
  }
  const current = executionDocumentSchema.safeParse(migrateExecutionDocument(value))
  if (current.success) {
    if (current.data.projectId !== projectId) {
      return {
        ...base,
        classification: 'unreadable',
        resumable: false,
        error: '执行记录 projectId 与文件工程不一致'
      }
    }
    return { ...base, classification: 'current', resumable: null, value: current.data }
  }
  const legacy = legacyOperationFactSchema.safeParse(value)
  if (legacy.success) {
    if (legacy.data.projectId !== projectId) {
      return {
        ...base,
        classification: 'unreadable',
        resumable: false,
        error: '执行记录 projectId 与文件工程不一致'
      }
    }
    return { ...base, classification: 'legacy', resumable: false, fact: legacy.data }
  }
  return {
    ...base,
    classification: 'unreadable',
    resumable: false,
    error: '执行记录不满足当前或 legacy 生产 schema'
  }
}

export function classifyExecutionEnvelope(
  value: unknown,
  projectId: string
): ExecutionEnvelopeClassification {
  if (!isObject(value) || !Array.isArray(value.executions)) {
    return {
      formatVersion: null,
      classification: 'unreadable',
      records: [],
      error: '执行记录信封缺少 version 或 executions'
    }
  }
  const version = value.version
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    ![1, 2, 3, 4, 5, 6, 7].includes(version)
  ) {
    return {
      formatVersion: typeof version === 'number' ? version : null,
      classification: 'unreadable',
      records: [],
      error: `不支持的执行记录信封版本：${String(version)}`
    }
  }
  const records = value.executions.map((record) => classifyExecutionRecord(record, projectId))
  const classification = records.some((record) => record.classification === 'unreadable')
    ? 'unreadable'
    : records.some((record) => record.classification === 'legacy')
      ? 'legacy'
      : 'current'
  return { formatVersion: version, classification, records }
}

export async function classifyOperationBytes(
  bytes: Uint8Array,
  expectedOperationId: string
): Promise<OperationBytesClassification> {
  let raw: unknown = null
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    raw = null
  }
  if (!OPERATION_ID_PATTERN.test(expectedOperationId)) {
    return {
      kind: 'unreadable',
      raw,
      error: '操作记录文件名不是合法 operationId'
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-r27-operation-'))
  try {
    const directory = join(root, '.git', 'opengalgame', 'operations')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${expectedOperationId}.json`), bytes)
    const read = await readOperationRecord(root, expectedOperationId).catch((error: unknown) => ({
      kind: 'unreadable' as const,
      error: error instanceof Error ? error.message : String(error)
    }))
    if (read.kind === 'ok') return { kind: 'current', record: read.record, raw }
    return {
      kind: 'unreadable',
      raw,
      error: read.kind === 'damaged' ? '真实操作记录读取器判 damaged' : '操作记录无法读取'
    }
  } catch (error) {
    return {
      kind: 'unreadable',
      raw,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { decodeStorageKey, planCanvasArrangementMigration }
