import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type {
  SceneCanvasArrangementPersistenceGateway,
  SceneCanvasArrangementRead,
  SceneCanvasPreservedArrangementFields,
  SceneCanvasPreservedCardFields
} from '@application/scene-canvas/ports/SceneCanvasArrangementPersistenceGateway'
import type {
  SceneCanvasArrangementVO,
  SceneCanvasCardVO
} from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasDefaultRelation
} from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'
import { resolveContained } from '@infrastructure/git/containedPath'
import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'
import {
  withProjectFileRead,
  type ProjectFileReadWindow
} from '@infrastructure/project-files/public/projectFileStorage'
import { parseJsonDocumentContent, writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'
import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema,
  sceneCanvasArrangementFormatProbeSchema,
  type SceneCanvasArrangementDocument
} from './documents/SceneCanvasArrangementDocument'
import {
  copyUsage,
  currentDocumentToModel,
  modelToCurrentDocument
} from './sceneArrangementCurrentMapping'
import { arrangementPath, CANVAS_DIRECTORY } from './sceneCanvasPaths'
import type { CanvasArrangementMigration } from './migration/CanvasArrangementMigration'

const writeFailure = {
  code: SceneCanvasErrorCodes.persistFailed,
  msg: '编排没能写入'
}

export type SceneCanvasProjectLocation = {
  projectId: string
  directory: string
}

/** 本机编排读写。不复制来源正文，不调用 Git。 */
export class LocalSceneCanvasArrangementPersistenceGatewayImpl implements SceneCanvasArrangementPersistenceGateway {
  constructor(
    private readonly locateProject: (projectId: string) => Promise<SceneCanvasProjectLocation>,
    private readonly migration: CanvasArrangementMigration
  ) {}

  /** 读取指定编排与同一份文件的保真快照。确认文件不存在时返回 null。 */
  async readArrangement(
    projectId: string,
    sceneId: string,
    canvasId: string
  ): Promise<SceneCanvasArrangementRead | null> {
    const project = await this.locate(projectId)
    if (sceneId.trim() !== '' && canvasId.trim() !== '') {
      try {
        await this.migration.ensureCurrent({
          projectId: project.projectId,
          directory: project.directory,
          sceneId,
          canvasId,
          trigger: 'open'
        })
      } catch {
        // 迁移失败不回退旧读；未能升级的旧格式随后按 unsupportedFormat 明确拒绝。
      }
    }
    try {
      return await withProjectFileRead(project.directory, project.projectId, async (window) => {
        const relativePath = requireArrangementPath(sceneId, canvasId)
        if (!(await arrangementFileExists(window, relativePath))) return null
        const file = await window.readOptionalUnboundedText(relativePath)
        if (file === null) {
          throw new AppException({
            code: SceneCanvasErrorCodes.readChanged,
            msg: '编排在读取期间发生变化'
          })
        }
        const arrangement = readArrangementModel(file.text, project.projectId, sceneId, canvasId)
        return {
          arrangement: toArrangementVO(arrangement),
          preserved: preservedArrangementFields(arrangement)
        }
      })
    } catch (error) {
      throw mapReadError(error)
    }
  }

  /**
   * 在允许目录内原子写入紧凑 JSON。
   * 先校验请求并序列化，再定位工程与路径，最后写入，保持原错误优先级。
   * VO 不承载的当前业务字段只从同一次读取的 base 保留；不再次读取既有文件。
   */
  async writeArrangement(
    arrangement: SceneCanvasArrangementVO,
    base: SceneCanvasArrangementRead | null
  ): Promise<void> {
    const model = toCurrentModel(arrangement, base?.preserved ?? null)
    validateSceneCanvasArrangement(model)
    const document = readableDocument(model)
    const project = await this.locate(arrangement.projectId)
    const relativePath = requireArrangementPath(arrangement.sceneId, arrangement.canvasId)
    let target: string
    try {
      target = await resolveContained(project.directory, relativePath)
    } catch (error) {
      throw mapReadError(error)
    }
    if (!relativePath.startsWith(`${CANVAS_DIRECTORY}/`)) {
      throw new AppException({
        code: SceneCanvasErrorCodes.pathEscapesProject,
        msg: '编排位置超出工程范围'
      })
    }
    await enqueueWorkWrite(project.directory, () =>
      writeJsonDocument(target, document, writeFailure, { compact: true })
    )
  }

  private async locate(projectId: string): Promise<SceneCanvasProjectLocation> {
    const project = await this.locateProject(projectId)
    if (project.projectId !== projectId) {
      throw new AppException({
        code: SceneCanvasErrorCodes.ownershipMismatch,
        msg: '工程文件归属不匹配'
      })
    }
    return project
  }
}

async function arrangementFileExists(
  window: ProjectFileReadWindow,
  relativePath: string
): Promise<boolean> {
  const canvases = await window.captureDirectory(CANVAS_DIRECTORY)
  if (canvases === null) return false
  const [, , sceneKey, fileName] = relativePath.split('/')
  if (!sceneKey || !fileName || !canvases.members.some((member) => member.name === sceneKey)) {
    return false
  }
  const scene = await window.captureDirectory(`${CANVAS_DIRECTORY}/${sceneKey}`)
  if (scene === null) return false
  return scene.members.some((member) => member.name === fileName)
}

/** 读取当前 v5 文档并校验为唯一当前模型。旧格式迁移失败后明确不支持。 */
function readArrangementModel(
  text: string,
  projectId: string,
  sceneId: string,
  canvasId: string
): SceneCanvasArrangement {
  const value = parseJsonDocumentContent(text, {
    code: SceneCanvasErrorCodes.contentDamaged,
    msg: '编排内容损坏'
  })
  const probe = sceneCanvasArrangementFormatProbeSchema.safeParse(value)
  if (!probe.success) {
    throw new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏'
    })
  }
  let arrangement: SceneCanvasArrangement
  if (probe.data.formatVersion === SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION) {
    const document = parseUnknownValue(
      sceneCanvasArrangementDocumentSchema,
      value,
      SceneCanvasErrorCodes.contentDamaged,
      '编排内容损坏'
    )
    assertSameIdentity(document, projectId, sceneId, canvasId)
    arrangement = currentDocumentToModel(document)
  } else {
    throw new AppException({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      msg: '编排格式不受支持'
    })
  }
  try {
    validateSceneCanvasArrangement(arrangement)
  } catch (error) {
    throw new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏',
      cause: error
    })
  }
  return arrangement
}

function assertSameIdentity(
  document: { projectId: string; sceneId: string; canvasId: string },
  projectId: string,
  sceneId: string,
  canvasId: string
): void {
  if (
    document.projectId !== projectId ||
    document.sceneId !== sceneId ||
    document.canvasId !== canvasId
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.ownershipMismatch,
      msg: '工程文件归属不匹配'
    })
  }
}

/** 从同一次读取的当前模型提取 VO 不承载的保真字段。 */
function preservedArrangementFields(
  arrangement: SceneCanvasArrangement
): SceneCanvasPreservedArrangementFields {
  const cards = new Map<string, SceneCanvasPreservedCardFields>()
  for (const card of arrangement.cards) {
    cards.set(card.cardId, {
      title: card.title,
      summary: card.summary,
      usage: copyUsage(card.usage)
    })
  }
  const relations = new Map<string, SceneCanvasDefaultRelation>()
  for (const relation of arrangement.relations) {
    relations.set(relation.relationId, relation.defaultRelation)
  }
  return { cards, relations }
}

function readableDocument(arrangement: SceneCanvasArrangement): SceneCanvasArrangementDocument {
  const parsed = sceneCanvasArrangementDocumentSchema.safeParse(modelToCurrentDocument(arrangement))
  if (!parsed.success) {
    throw new AppException({
      code: SceneCanvasErrorCodes.persistFailed,
      msg: '编排没能写入',
      cause: parsed.error
    })
  }
  return parsed.data
}

function requireArrangementPath(sceneId: string, canvasId: string): string {
  if (sceneId.trim() === '' || canvasId.trim() === '') {
    throw new AppException({
      code: SceneCanvasErrorCodes.invalidField,
      msg: '画布身份不能为空'
    })
  }
  return arrangementPath(sceneId, canvasId)
}

function mapReadError(error: unknown): AppException {
  if (!(error instanceof AppException)) {
    return new AppException({
      code: SceneCanvasErrorCodes.readFailed,
      msg: '编排无法读取',
      cause: error
    })
  }
  if (
    error.code === ErrorCodes.forbidden ||
    error.code === ProjectFileErrorCodes.pathEscapesProject
  ) {
    return new AppException({
      code: SceneCanvasErrorCodes.pathEscapesProject,
      msg: '编排位置超出工程范围',
      cause: error
    })
  }
  if (error.code === ProjectFileErrorCodes.contentDamaged) {
    return new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏',
      cause: error
    })
  }
  if (error.code === ProjectFileErrorCodes.readChanged) {
    return new AppException({
      code: SceneCanvasErrorCodes.readChanged,
      msg: '编排在读取期间发生变化',
      cause: error
    })
  }
  if (error.code === ProjectFileErrorCodes.ownershipMismatch) {
    return new AppException({
      code: SceneCanvasErrorCodes.ownershipMismatch,
      msg: '工程文件归属不匹配',
      cause: error
    })
  }
  if (error.code === ProjectFileErrorCodes.readFailed) {
    return new AppException({
      code: SceneCanvasErrorCodes.readFailed,
      msg: '编排无法读取',
      cause: error
    })
  }
  return error
}

/**
 * VO 转唯一当前模型。VO 承载的字段取请求值；
 * 提示词/字段卡标题与全部卡片 usage、关系 defaultRelation 取已保存值，
 * 没有已保存值时使用既有默认语义（标题=cardId、简介空、usage 空、关系 associated）。
 */
function toCurrentModel(
  arrangement: SceneCanvasArrangementVO,
  preserved: SceneCanvasPreservedArrangementFields | null
): SceneCanvasArrangement {
  return {
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map((card) => toCurrentCard(card, preserved)),
    relations: arrangement.relations.map((relation) => ({
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      defaultRelation: preserved?.relations.get(relation.relationId) ?? 'associated',
      specificName: relation.specificName,
      recordCardId: relation.recordCardId
    }))
  }
}

function toCurrentCard(
  card: SceneCanvasCardVO,
  preserved: SceneCanvasPreservedArrangementFields | null
): SceneCanvasCard {
  const saved = preserved?.cards.get(card.cardId)
  const usage = saved === undefined ? { targetIds: [] } : copyUsage(saved.usage)
  if (card.kind === 'prompt') {
    return {
      kind: 'prompt',
      cardId: card.cardId,
      title: saved?.title ?? card.cardId,
      summary: saved?.summary ?? '',
      body: card.body,
      references: card.references.map((reference) => ({ cardId: reference.cardId })),
      usage,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'animation' || card.kind === 'effect') {
    const base = {
      cardId: card.cardId,
      title: saved?.title ?? card.cardId,
      summary: saved?.summary ?? '',
      webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
      usage,
      layout: { ...card.layout }
    }
    return card.kind === 'animation'
      ? { ...base, kind: 'animation' as const }
      : { ...base, kind: 'effect' as const }
  }
  if (card.kind === 'image') {
    return {
      kind: 'image',
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      usage,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'audio') {
    return {
      kind: 'audio',
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      usage,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'document') {
    return {
      kind: 'document',
      cardId: card.cardId,
      sourceId: card.sourceId,
      title: card.title,
      summary: card.summary,
      usage,
      layout: { ...card.layout }
    }
  }
  return {
    kind: 'video',
    cardId: card.cardId,
    sourceId: card.sourceId,
    title: card.title,
    summary: card.summary,
    usage,
    layout: { ...card.layout }
  }
}

/** 当前模型投影为应用层 VO。VO 不承载 usage/defaultRelation 与提示词/字段卡 title/summary。 */
function toArrangementVO(arrangement: SceneCanvasArrangement): SceneCanvasArrangementVO {
  return {
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map((card) => {
      if (card.kind === 'prompt') {
        return {
          kind: 'prompt' as const,
          cardId: card.cardId,
          body: card.body,
          references: card.references.map((reference) => ({ cardId: reference.cardId })),
          layout: { ...card.layout }
        }
      }
      if (card.kind === 'animation' || card.kind === 'effect') {
        const base = {
          cardId: card.cardId,
          webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
          layout: { ...card.layout }
        }
        return card.kind === 'animation'
          ? { ...base, kind: 'animation' as const }
          : { ...base, kind: 'effect' as const }
      }
      if (card.kind === 'image') {
        return {
          kind: 'image',
          cardId: card.cardId,
          sourceId: card.sourceId,
          role: card.role,
          title: card.title,
          summary: card.summary,
          layout: { ...card.layout }
        }
      }
      if (card.kind === 'audio') {
        return {
          kind: 'audio',
          cardId: card.cardId,
          sourceId: card.sourceId,
          role: card.role,
          title: card.title,
          summary: card.summary,
          layout: { ...card.layout }
        }
      }
      if (card.kind === 'document') {
        return {
          kind: 'document',
          cardId: card.cardId,
          sourceId: card.sourceId,
          title: card.title,
          summary: card.summary,
          layout: { ...card.layout }
        }
      }
      return {
        kind: 'video',
        cardId: card.cardId,
        sourceId: card.sourceId,
        title: card.title,
        summary: card.summary,
        layout: { ...card.layout }
      }
    }),
    relations: arrangement.relations.map((relation) => ({
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      specificName: relation.specificName,
      recordCardId: relation.recordCardId
    }))
  }
}
