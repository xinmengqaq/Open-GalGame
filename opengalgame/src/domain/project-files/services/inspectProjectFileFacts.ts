import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '../errors/ProjectFileErrorCodes'
import {
  sceneCanvasCardSourceId,
  type SceneCanvasArrangement
} from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'
import type {
  ProjectFileDiagnostic,
  ProjectFileInspection,
  ProjectFileInspectionFacts,
  ProjectInputSourceFact,
  SceneCanvasArrangementInspectionItem
} from '../models/ProjectFileDiagnostic'
import type { ProjectInputSource } from '../models/ProjectInputSource'
import { validateProjectInputSource } from './validateProjectInputSource'

/**
 * 汇总已解析工程文件事实中的格式支持和诊断。
 * 不修复文件，也不删除断开引用的卡片。
 * @throws {AppException} 工程身份为空，或问题对象没有可识别身份。
 */
export function inspectProjectFileFacts(facts: ProjectFileInspectionFacts): ProjectFileInspection {
  if (typeof facts.projectId !== 'string' || facts.projectId.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankArrangementIdentity,
      msg: '工程身份不能为空'
    })
  }
  const diagnostics: ProjectFileDiagnostic[] = []
  const presentSourceIds = new Set<string>()
  const seenSourceIds = new Set<string>()
  for (const fact of facts.sources) {
    const sourceId = sourceIdentity(fact)
    if (fact.availability === 'present' && acceptSource(fact.source, sourceId, diagnostics)) {
      presentSourceIds.add(sourceId)
    } else if (fact.availability !== 'present') {
      diagnostics.push({
        objectId: sourceId,
        kind: fact.availability === 'missing' ? 'missing' : 'damaged'
      })
    }
    if (seenSourceIds.has(sourceId)) {
      diagnostics.push({ objectId: sourceId, kind: 'duplicateIdentity' })
    } else {
      seenSourceIds.add(sourceId)
    }
  }
  const seenArrangements = new Set<string>()
  for (const fact of facts.arrangements) {
    inspectArrangement(fact, presentSourceIds, seenArrangements, diagnostics)
  }
  if (facts.catalogDamaged) {
    diagnostics.push({ objectId: facts.projectId, kind: 'damaged' })
  }
  return {
    projectId: facts.projectId,
    inputSourceFormatSupported: facts.inputSourceFormatSupported,
    canvasArrangementFormatSupported: facts.canvasArrangementFormatSupported,
    diagnostics
  }
}

function acceptSource(
  source: ProjectInputSource,
  sourceId: string,
  diagnostics: ProjectFileDiagnostic[]
): boolean {
  try {
    validateProjectInputSource(source)
    return true
  } catch (error) {
    if (!(error instanceof AppException)) throw error
    diagnostics.push({ objectId: sourceId, kind: 'damaged' })
    return false
  }
}

function inspectArrangement(
  fact: SceneCanvasArrangementInspectionItem,
  presentSourceIds: ReadonlySet<string>,
  seenArrangements: Set<string>,
  diagnostics: ProjectFileDiagnostic[]
): void {
  if (fact.availability !== 'present') {
    requireObjectId(fact.objectId)
    diagnostics.push({ objectId: fact.objectId, kind: fact.availability })
    return
  }
  const objectId = arrangementObjectId(fact.arrangement)
  try {
    validateSceneCanvasArrangement(fact.arrangement)
  } catch (error) {
    if (!(error instanceof AppException)) throw error
    diagnostics.push({ objectId, kind: 'damaged' })
    return
  }
  const arrangementKey = `${fact.arrangement.sceneId}\u0000${fact.arrangement.canvasId}`
  if (seenArrangements.has(arrangementKey)) {
    diagnostics.push({ objectId, kind: 'duplicateIdentity' })
  } else {
    seenArrangements.add(arrangementKey)
  }
  for (const card of fact.arrangement.cards) {
    const sourceId = sceneCanvasCardSourceId(card)
    if (sourceId !== null && !presentSourceIds.has(sourceId)) {
      diagnostics.push({ objectId: card.cardId, kind: 'brokenReference' })
    }
  }
}

function arrangementObjectId(arrangement: SceneCanvasArrangement): string {
  if (typeof arrangement.canvasId !== 'string' || arrangement.canvasId.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankArrangementIdentity,
      msg: '画布身份不能为空'
    })
  }
  return arrangement.canvasId
}

function requireObjectId(objectId: string): void {
  if (typeof objectId !== 'string' || objectId.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankArrangementIdentity,
      msg: '编排对象身份不能为空'
    })
  }
}

function sourceIdentity(fact: ProjectInputSourceFact): string {
  const sourceId = fact.availability === 'present' ? fact.source.sourceId : fact.sourceId
  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankSourceId,
      msg: '来源身份不能为空'
    })
  }
  return sourceId
}
