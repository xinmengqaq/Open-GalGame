import type {
  SceneCanvasDefaultRelation,
  SceneCanvasUsage
} from '@domain/scene-canvas/models/SceneCanvasArrangement'

import type { SceneCanvasArrangementVO } from '../vo/SceneCanvasArrangementVO'

export type SceneCanvasPreservedCardFields = {
  title: string
  summary: string
  usage: SceneCanvasUsage
}

export type SceneCanvasPreservedArrangementFields = {
  cards: ReadonlyMap<string, SceneCanvasPreservedCardFields>
  relations: ReadonlyMap<string, SceneCanvasDefaultRelation>
}

export type SceneCanvasArrangementRead = {
  arrangement: SceneCanvasArrangementVO
  preserved: SceneCanvasPreservedArrangementFields
}

export interface SceneCanvasArrangementPersistenceGateway {
  readArrangement(
    projectId: string,
    sceneId: string,
    canvasId: string
  ): Promise<SceneCanvasArrangementRead | null>

  writeArrangement(
    arrangement: SceneCanvasArrangementVO,
    base: SceneCanvasArrangementRead | null
  ): Promise<void>
}
