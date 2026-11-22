import type { SceneCanvasArrangement } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'

import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema,
  sceneCanvasArrangementFormatProbeSchema,
  type SceneCanvasArrangementDocument
} from '../documents/SceneCanvasArrangementDocument'
import { toArrangementVersion } from '../mapping/SceneCanvasArrangementReadFactsMapper'
import { modelToCurrentDocument } from '../sceneArrangementCurrentMapping'
import { sceneCanvasArrangementDocumentSchema as legacyV3DocumentSchema } from './legacy/documents/LegacySceneCanvasArrangementDocument'
import {
  SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION,
  sceneCanvasArrangementV4DocumentSchema
} from './legacy/documents/SceneCanvasArrangementV4Document'
import { toCanvasArrangement } from './legacy/mapping/LegacyCanvasArrangementReadFactsMapper'
import {
  currentToLegacyCanvasArrangement,
  legacyProjectCanvasArrangementToCurrent,
  v4DocumentToCurrent
} from './legacy/mapping/LegacySceneArrangementMapping'
import { validateCanvasArrangement } from './legacy/services/LegacyValidateCanvasArrangement'

export type CanvasMigrationDefaultSource =
  'v3-schema-default' | 'v4-schema-default' | 'v4-not-saved'

export type CanvasMigrationNormalizeReason = 'v3-absent-references' | 'v4-absent-references'

export type CanvasMigrationFieldRef = {
  object: 'card' | 'relation'
  objectId: string
  field: string
}

export type CanvasMigrationDefaultedField = CanvasMigrationFieldRef & {
  source: CanvasMigrationDefaultSource
}

export type CanvasMigrationNormalizedField = CanvasMigrationFieldRef & {
  reason: CanvasMigrationNormalizeReason
}

export type CanvasArrangementMigrationIdentity = {
  projectId: string
  sceneId: string
  canvasId: string
}

export type CanvasArrangementMigrationPlan =
  | {
      ok: true
      sourceVersion: 3 | 4
      targetVersion: 5
      document: SceneCanvasArrangementDocument
      model: SceneCanvasArrangement
      preserved: string[]
      defaulted: CanvasMigrationDefaultedField[]
      normalized: CanvasMigrationNormalizedField[]
      unsupported: string[]
    }
  | {
      ok: false
      reason: 'current' | 'unsupported' | 'damaged' | 'identity'
      sourceVersion: number | null
    }

type RawCard = { kind?: unknown; cardId?: unknown }
type RawRelation = { relationId?: unknown }
type RawDocument = { cards?: RawCard[]; relations?: RawRelation[] }

export function planCanvasArrangementMigration(
  value: unknown,
  identity: CanvasArrangementMigrationIdentity,
  sourceDigest: string
): CanvasArrangementMigrationPlan {
  const probe = sceneCanvasArrangementFormatProbeSchema.safeParse(value)
  if (!probe.success) {
    return { ok: false, reason: 'damaged', sourceVersion: null }
  }
  const sourceVersion = probe.data.formatVersion
  if (sourceVersion === SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION) {
    return { ok: false, reason: 'current', sourceVersion }
  }
  if (sourceVersion === 3) {
    const parsed = legacyV3DocumentSchema.safeParse(value)
    if (!parsed.success) return { ok: false, reason: 'damaged', sourceVersion: 3 }
    if (
      parsed.data.projectId !== identity.projectId ||
      parsed.data.sceneId !== identity.sceneId ||
      parsed.data.canvasId !== identity.canvasId
    ) {
      return { ok: false, reason: 'identity', sourceVersion: 3 }
    }
    const version = toArrangementVersion(
      parsed.data.projectId,
      parsed.data.sceneId,
      parsed.data.canvasId,
      sourceDigest
    )
    try {
      const legacy = toCanvasArrangement(parsed.data, version)
      validateCanvasArrangement(legacy)
      const model = legacyProjectCanvasArrangementToCurrent(legacy)
      validateSceneCanvasArrangement(model)
      return {
        ok: true,
        sourceVersion: 3,
        targetVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
        document: sceneCanvasArrangementDocumentSchema.parse(modelToCurrentDocument(model)),
        model,
        preserved: preservedFields(value),
        defaulted: defaultedV3(value),
        normalized: absentPromptReferences(value, 'v3-absent-references'),
        unsupported: []
      }
    } catch {
      return { ok: false, reason: 'damaged', sourceVersion: 3 }
    }
  }
  if (sourceVersion === SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION) {
    const parsed = sceneCanvasArrangementV4DocumentSchema.safeParse(value)
    if (!parsed.success) return { ok: false, reason: 'damaged', sourceVersion: 4 }
    if (
      parsed.data.projectId !== identity.projectId ||
      parsed.data.sceneId !== identity.sceneId ||
      parsed.data.canvasId !== identity.canvasId
    ) {
      return { ok: false, reason: 'identity', sourceVersion: 4 }
    }
    const version = toArrangementVersion(
      parsed.data.projectId,
      parsed.data.sceneId,
      parsed.data.canvasId,
      sourceDigest
    )
    try {
      const { arrangement: model } = v4DocumentToCurrent(parsed.data)
      validateCanvasArrangement(currentToLegacyCanvasArrangement(model, version))
      validateSceneCanvasArrangement(model)
      return {
        ok: true,
        sourceVersion: 4,
        targetVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
        document: sceneCanvasArrangementDocumentSchema.parse(modelToCurrentDocument(model)),
        model,
        preserved: preservedFields(value),
        defaulted: defaultedV4(value),
        normalized: absentPromptReferences(value, 'v4-absent-references'),
        unsupported: []
      }
    } catch {
      return { ok: false, reason: 'damaged', sourceVersion: 4 }
    }
  }
  return { ok: false, reason: 'unsupported', sourceVersion }
}

function preservedFields(value: unknown): string[] {
  const raw = value as RawDocument & Record<string, unknown>
  const preserved: string[] = []
  for (const field of ['projectId', 'sceneId', 'canvasId', 'viewport']) {
    if (Object.hasOwn(raw, field)) preserved.push(field)
  }
  for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
    const cardId = typeof card.cardId === 'string' ? card.cardId : ''
    for (const field of [
      'kind',
      'cardId',
      'title',
      'summary',
      'body',
      'sourceId',
      'role',
      'references',
      'webgalPreset',
      'usage',
      'layout'
    ]) {
      if (Object.hasOwn(card, field)) preserved.push(`cards[${cardId}].${field}`)
    }
  }
  for (const relation of Array.isArray(raw.relations) ? raw.relations : []) {
    const relationId = typeof relation.relationId === 'string' ? relation.relationId : ''
    for (const field of [
      'relationId',
      'fromCardId',
      'toCardId',
      'defaultRelation',
      'specificName',
      'recordCardId'
    ]) {
      if (Object.hasOwn(relation, field)) {
        preserved.push(`relations[${relationId}].${field}`)
      }
    }
  }
  return preserved
}

function defaultedV3(value: unknown): CanvasMigrationDefaultedField[] {
  const raw = value as RawDocument
  const defaulted: CanvasMigrationDefaultedField[] = []
  for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
    const cardId = typeof card.cardId === 'string' ? card.cardId : ''
    if (!Object.hasOwn(card, 'summary')) {
      defaulted.push({
        object: 'card',
        objectId: cardId,
        field: 'summary',
        source: 'v3-schema-default'
      })
    }
  }
  return defaulted
}

function defaultedV4(value: unknown): CanvasMigrationDefaultedField[] {
  const raw = value as RawDocument
  const defaulted: CanvasMigrationDefaultedField[] = []
  for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
    const cardId = typeof card.cardId === 'string' ? card.cardId : ''
    const kind = card.kind
    if (kind === 'prompt' || kind === 'animation' || kind === 'effect') {
      defaulted.push(
        { object: 'card', objectId: cardId, field: 'title', source: 'v4-not-saved' },
        { object: 'card', objectId: cardId, field: 'summary', source: 'v4-not-saved' },
        { object: 'card', objectId: cardId, field: 'usage', source: 'v4-not-saved' }
      )
      continue
    }
    if (
      (kind === 'image' || kind === 'audio' || kind === 'video') &&
      !Object.hasOwn(card, 'summary')
    ) {
      defaulted.push({
        object: 'card',
        objectId: cardId,
        field: 'summary',
        source: 'v4-schema-default'
      })
    }
    defaulted.push({
      object: 'card',
      objectId: cardId,
      field: 'usage',
      source: 'v4-not-saved'
    })
  }
  for (const relation of Array.isArray(raw.relations) ? raw.relations : []) {
    defaulted.push({
      object: 'relation',
      objectId: typeof relation.relationId === 'string' ? relation.relationId : '',
      field: 'defaultRelation',
      source: 'v4-not-saved'
    })
  }
  return defaulted
}

function absentPromptReferences(
  value: unknown,
  reason: CanvasMigrationNormalizeReason
): CanvasMigrationNormalizedField[] {
  const raw = value as RawDocument
  const normalized: CanvasMigrationNormalizedField[] = []
  for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
    if (card.kind !== 'prompt' || Object.hasOwn(card, 'references')) continue
    normalized.push({
      object: 'card',
      objectId: typeof card.cardId === 'string' ? card.cardId : '',
      field: 'references',
      reason
    })
  }
  return normalized
}
