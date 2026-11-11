import type { ProjectCanvasArrangement } from '@domain/project-files/models/ProjectCanvasArrangement'
import type {
  ProjectInputSource,
  ProjectInputSourceSummary
} from '@domain/project-files/models/ProjectInputSource'
import type { ProjectInputSourceDocument } from '../documents/ProjectInputSourceDocument'
import type { SceneCanvasArrangementDocument } from '../documents/SceneCanvasArrangementDocument'
import { digestVersionParts } from '../projectFilePaths'
import type { SourceCatalogRecord } from '../reading/ProjectInputSourceCatalog'

/**
 * @param content - 正文；文件素材不使用该值。
 */
export function toProjectInputSource(
  document: ProjectInputSourceDocument,
  content: string,
  version: string
): ProjectInputSource {
  const contentKind = document.content.kind
  if (contentKind === 'document') {
    return {
      sourceId: document.sourceId,
      version,
      contentKind: 'text',
      textKind: 'document',
      title: document.content.title,
      body: content,
      topics: [...document.content.topics],
      importFormat: document.content.importFormat
    }
  }
  return {
    sourceId: document.sourceId,
    version,
    contentKind: document.content.fileType,
    name: document.content.name,
    fileId: document.content.fileId,
    description: document.content.description
  }
}

/**
 * 把目录记录转换成扫描摘要。无法识别类别时为 null。
 * @returns 摘要；描述损坏且没有类别时为 null。
 */
export function toSourceSummary(
  record: SourceCatalogRecord,
  readable: boolean
): ProjectInputSourceSummary | null {
  if (!('document' in record) || record.document === undefined) return null
  const content = record.document.content
  const sourceId = record.claimedId ?? record.document.sourceId
  if (content.kind === 'document') {
    return {
      sourceId,
      name: content.title,
      readable,
      contentKind: 'text',
      textKind: 'document'
    }
  }
  return {
    sourceId,
    name: content.name,
    readable,
    contentKind: content.fileType
  }
}

/**
 * @returns 不含来源正文的编排事实。提示词正文保留在提示词卡片中。
 */
export function toCanvasArrangement(
  document: SceneCanvasArrangementDocument,
  version: string
): ProjectCanvasArrangement {
  return {
    projectId: document.projectId,
    sceneId: document.sceneId,
    canvasId: document.canvasId,
    version,
    viewport: { ...document.viewport },
    cards: document.cards.map((card) => {
      const shared = {
        cardId: card.cardId,
        title: card.title,
        summary: card.summary,
        usage: copyUsage(card.usage),
        layout: { ...card.layout }
      }
      if (card.kind === 'prompt') {
        return {
          ...shared,
          kind: 'prompt' as const,
          body: card.body,
          references: (card.references ?? []).map((reference) => ({ cardId: reference.cardId }))
        }
      }
      if (card.kind === 'animation' || card.kind === 'effect') {
        return {
          ...shared,
          kind: card.kind,
          webgalPreset:
            card.webgalPreset === null
              ? null
              : { command: card.webgalPreset.command, name: card.webgalPreset.name }
        }
      }
      if (card.kind === 'document' || card.kind === 'video') {
        return { ...shared, kind: card.kind, sourceId: card.sourceId }
      }
      if (card.kind === 'image') {
        return { ...shared, kind: 'image' as const, sourceId: card.sourceId, role: card.role }
      }
      return { ...shared, kind: 'audio' as const, sourceId: card.sourceId, role: card.role }
    }),
    relations: document.relations.map((relation) => ({
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      defaultRelation: relation.defaultRelation,
      specificName: relation.specificName,
      recordCardId: relation.recordCardId
    }))
  }
}

function copyUsage(usage: SceneCanvasArrangementDocument['cards'][number]['usage']): {
  characterId?: string
  locationId?: string
  spokenLine?: string
  targetIds: string[]
} {
  return {
    ...(usage.characterId === undefined ? {} : { characterId: usage.characterId }),
    ...(usage.locationId === undefined ? {} : { locationId: usage.locationId }),
    ...(usage.spokenLine === undefined ? {} : { spokenLine: usage.spokenLine }),
    targetIds: [...usage.targetIds]
  }
}

export function toReadVersion(
  projectId: string,
  sources: readonly { sourceId: string; version: string }[]
): string {
  const ordered = [...sources].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
  )
  return digestVersionParts([
    'project-file-read-v1',
    projectId,
    ordered.map((source) => [source.sourceId, source.version])
  ])
}

export function toArrangementVersion(
  projectId: string,
  sceneId: string,
  canvasId: string,
  fileDigest: string
): string {
  return digestVersionParts([
    'project-file-arrangement-v1',
    projectId,
    sceneId,
    canvasId,
    fileDigest
  ])
}
