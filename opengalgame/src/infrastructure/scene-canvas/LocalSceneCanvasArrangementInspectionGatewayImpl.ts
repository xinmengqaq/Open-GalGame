import type { VerifiedProjectReadLocation } from '@application/project-files/models/ProjectInputSourceReadFacts'
import type { SceneCanvasArrangementInspectionFact } from '@application/project-files/models/SceneCanvasArrangementReadFacts'
import type { SceneCanvasArrangementReaderGateway } from '@application/project-files/ports/SceneCanvasArrangementReaderGateway'
import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import type { SceneCanvasArrangementInspectionItem } from '@domain/project-files/models/ProjectFileDiagnostic'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { SceneCanvasArrangement } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'
import {
  isTemporaryDocumentName,
  parseJsonDocumentContent
} from '@infrastructure/storage/jsonDocument'
import { StableFileReadError } from '@infrastructure/storage/StableProjectFileReader'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'
import {
  decodeStorageKey,
  identityFromDescriptorName,
  withProjectFileRead,
  type ProjectFileReadWindow
} from '@infrastructure/project-files/public/projectFileStorage'
import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema,
  sceneCanvasArrangementFormatProbeSchema
} from './documents/SceneCanvasArrangementDocument'
import { currentDocumentToModel } from './sceneArrangementCurrentMapping'
import { arrangementPath, CANVAS_DIRECTORY } from './sceneCanvasPaths'

/** 用当前编排格式检查工程内已保存编排。不删除卡片，也不加载来源正文。 */
export class LocalSceneCanvasArrangementInspectionGatewayImpl implements SceneCanvasArrangementReaderGateway {
  inspectSceneCanvasArrangements(
    project: VerifiedProjectReadLocation
  ): Promise<SceneCanvasArrangementInspectionFact> {
    return withProjectFileRead(project.location.directory, project.projectId, async (window) => {
      const records = await loadArrangementCatalog(window)
      let canvasArrangementFormatSupported = true
      const arrangements: SceneCanvasArrangementInspectionItem[] = []
      for (const record of records) {
        if (record.status === 'unsupported') {
          canvasArrangementFormatSupported = false
          continue
        }
        if (record.status === 'damaged' || record.status === 'missing') {
          arrangements.push({ availability: record.status, objectId: record.canvasId })
          continue
        }
        if (record.status !== 'present') continue
        arrangements.push({ availability: 'present', arrangement: record.arrangement })
      }
      return {
        projectId: window.projectId,
        canvasArrangementFormatSupported,
        arrangements
      }
    })
  }
}

type ArrangementRecord =
  | { status: 'present'; canvasId: string; arrangement: SceneCanvasArrangement }
  | { status: 'damaged' | 'missing' | 'unsupported'; canvasId: string }

async function loadArrangementCatalog(window: ProjectFileReadWindow): Promise<ArrangementRecord[]> {
  const canvases = await window.captureDirectory(CANVAS_DIRECTORY)
  if (canvases === null) return []
  const records: ArrangementRecord[] = []
  for (const scene of canvases.members) {
    if (isTemporaryDocumentName(scene.name)) continue
    const sceneId = decodeStorageKey(scene.name)
    if (sceneId === null || !scene.stats.isDirectory()) {
      throw new AppException({
        code: ProjectFileErrorCodes.readFailed,
        msg: '工程文件无法读取'
      })
    }
    const sceneDirectory = `${CANVAS_DIRECTORY}/${scene.name}`
    const files = await window.captureDirectory(sceneDirectory)
    if (files === null) {
      throw new AppException({
        code: ProjectFileErrorCodes.readChanged,
        msg: '工程文件在读取期间发生变化'
      })
    }
    for (const file of files.members) {
      if (isTemporaryDocumentName(file.name)) continue
      const canvasId = identityFromDescriptorName(file.name)
      if (canvasId === null || !file.stats.isFile()) {
        throw new AppException({
          code: ProjectFileErrorCodes.readFailed,
          msg: '工程文件无法读取'
        })
      }
      records.push(await readArrangementRecord(window, sceneId, canvasId))
    }
  }
  return records
}

async function readArrangementRecord(
  window: ProjectFileReadWindow,
  sceneId: string,
  canvasId: string
): Promise<ArrangementRecord> {
  const relativePath = arrangementPath(sceneId, canvasId)
  try {
    const file = await window.readOptionalUnboundedText(relativePath)
    if (file === null) return { status: 'missing', canvasId }
    const arrangement = parseArrangementFile(window, sceneId, canvasId, file.text)
    if (arrangement === null) return { status: 'unsupported', canvasId }
    return { status: 'present', canvasId, arrangement }
  } catch (error) {
    if (
      error instanceof AppException &&
      (error.code === SceneCanvasErrorCodes.unsupportedFormat ||
        error.code === ProjectFileErrorCodes.unsupportedFormat)
    ) {
      return { status: 'unsupported', canvasId }
    }
    if (
      error instanceof AppException &&
      (error.code === SceneCanvasErrorCodes.contentDamaged ||
        error.code === SceneCanvasErrorCodes.ownershipMismatch ||
        error.code === ProjectFileErrorCodes.contentDamaged ||
        error.code === ProjectFileErrorCodes.ownershipMismatch)
    ) {
      return { status: 'damaged', canvasId }
    }
    if (error instanceof StableFileReadError && error.kind === 'invalid-text') {
      return { status: 'damaged', canvasId }
    }
    throw error
  }
}

function parseArrangementFile(
  window: ProjectFileReadWindow,
  sceneId: string,
  canvasId: string,
  text: string
): SceneCanvasArrangement | null {
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
  const formatVersion = probe.data.formatVersion
  let arrangement: SceneCanvasArrangement
  if (formatVersion === SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION) {
    const document = parseUnknownValue(
      sceneCanvasArrangementDocumentSchema,
      value,
      SceneCanvasErrorCodes.contentDamaged,
      '编排内容损坏'
    )
    assertOwnership(document, window, sceneId, canvasId)
    arrangement = currentDocumentToModel(document)
  } else {
    return null
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

function assertOwnership(
  document: { projectId: string; sceneId: string; canvasId: string },
  window: ProjectFileReadWindow,
  sceneId: string,
  canvasId: string
): void {
  if (
    document.projectId !== window.projectId ||
    document.sceneId !== sceneId ||
    document.canvasId !== canvasId
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.ownershipMismatch,
      msg: '工程文件归属不匹配'
    })
  }
}
