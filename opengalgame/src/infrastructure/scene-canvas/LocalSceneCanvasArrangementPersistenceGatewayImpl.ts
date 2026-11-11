import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneCanvasArrangementPersistenceGateway } from '@application/scene-canvas/ports/SceneCanvasArrangementPersistenceGateway'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { SceneCanvasArrangement } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  arrangementPath,
  projectFileLocations
} from '@infrastructure/project-files/projectFilePaths'
import {
  withProjectFileRead,
  type ProjectFileReadWindow
} from '@infrastructure/project-files/reading/ProjectFileReadWindow'
import { parseJsonDocumentContent, writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'
import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema,
  sceneCanvasArrangementFormatProbeSchema,
  type SceneCanvasArrangementDocument
} from './documents/SceneCanvasArrangementDocument'

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
    private readonly locateProject: (projectId: string) => Promise<SceneCanvasProjectLocation>
  ) {}

  /** 读取指定编排。确认文件不存在时返回 null。 */
  async readArrangement(
    projectId: string,
    sceneId: string,
    canvasId: string
  ): Promise<SceneCanvasArrangementVO | null> {
    const project = await this.locate(projectId)
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
        return parseArrangementText(file.text, project.projectId, sceneId, canvasId)
      })
    } catch (error) {
      throw mapReadError(error)
    }
  }

  /** 在允许目录内原子写入紧凑 JSON。写入前确认读取格式能够接受。 */
  async writeArrangement(arrangement: SceneCanvasArrangementVO): Promise<void> {
    validateSceneCanvasArrangement(toDomain(arrangement))
    const document = readableDocument(arrangement)
    const project = await this.locate(arrangement.projectId)
    const relativePath = requireArrangementPath(arrangement.sceneId, arrangement.canvasId)
    let target: string
    try {
      target = await resolveContained(project.directory, relativePath)
    } catch (error) {
      throw mapReadError(error)
    }
    if (!relativePath.startsWith(`${projectFileLocations.canvases}/`)) {
      throw new AppException({
        code: SceneCanvasErrorCodes.pathEscapesProject,
        msg: '编排位置超出工程范围'
      })
    }
    await writeJsonDocument(target, document, writeFailure, { compact: true })
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
  const canvases = await window.captureDirectory(projectFileLocations.canvases)
  if (canvases === null) return false
  const [, , sceneKey, fileName] = relativePath.split('/')
  if (!sceneKey || !fileName || !canvases.members.some((member) => member.name === sceneKey)) {
    return false
  }
  const scene = await window.captureDirectory(`${projectFileLocations.canvases}/${sceneKey}`)
  if (scene === null) return false
  return scene.members.some((member) => member.name === fileName)
}

function parseArrangementText(
  text: string,
  projectId: string,
  sceneId: string,
  canvasId: string
): SceneCanvasArrangementVO {
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
  if (probe.data.formatVersion !== SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION) {
    throw new AppException({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      msg: '编排格式不受支持'
    })
  }
  const document = parseUnknownValue(
    sceneCanvasArrangementDocumentSchema,
    value,
    SceneCanvasErrorCodes.contentDamaged,
    '编排内容损坏'
  )
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
  const arrangement = toVO(document)
  try {
    validateSceneCanvasArrangement(toDomain(arrangement))
  } catch (error) {
    throw new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏',
      cause: error
    })
  }
  return arrangement
}

function readableDocument(arrangement: SceneCanvasArrangementVO): SceneCanvasArrangementDocument {
  const parsed = sceneCanvasArrangementDocumentSchema.safeParse(toDocument(arrangement))
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

function toDocument(arrangement: SceneCanvasArrangementVO): SceneCanvasArrangementDocument {
  return {
    formatVersion: SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map((card) =>
      card.kind === 'prompt'
        ? {
            ...card,
            references: card.references.map((reference) => ({ cardId: reference.cardId })),
            layout: { ...card.layout }
          }
        : { ...card, layout: { ...card.layout } }
    ),
    relations: arrangement.relations.map((relation) => ({ ...relation }))
  }
}

function toVO(document: SceneCanvasArrangementDocument): SceneCanvasArrangementVO {
  return {
    projectId: document.projectId,
    sceneId: document.sceneId,
    canvasId: document.canvasId,
    viewport: { ...document.viewport },
    cards: document.cards.map((card) => {
      if (card.kind === 'animation' || card.kind === 'effect') {
        return {
          kind: card.kind,
          cardId: card.cardId,
          webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
          layout: { ...card.layout }
        }
      }
      if (card.kind === 'prompt') {
        return {
          kind: 'prompt' as const,
          cardId: card.cardId,
          body: card.body,
          references: (card.references ?? []).map((reference) => ({ cardId: reference.cardId })),
          layout: { ...card.layout }
        }
      }
      return { ...card, layout: { ...card.layout } }
    }),
    relations: document.relations.map((relation) => ({ ...relation }))
  }
}

function toDomain(arrangement: SceneCanvasArrangementVO): SceneCanvasArrangement {
  return arrangement
}
