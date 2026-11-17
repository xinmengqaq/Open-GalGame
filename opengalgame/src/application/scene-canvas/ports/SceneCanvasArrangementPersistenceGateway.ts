import type {
  SceneCanvasDefaultRelation,
  SceneCanvasUsage
} from '@domain/scene-canvas/models/SceneCanvasArrangement'

import type { SceneCanvasArrangementVO } from '../vo/SceneCanvasArrangementVO'

/** VO 不承载、仅在应用层与持久化实现之间传递的卡片保真字段。 */
export type SceneCanvasPreservedCardFields = {
  title: string
  summary: string
  usage: SceneCanvasUsage
}

/** VO 不承载、仅在应用层与持久化实现之间传递的编排保真字段。 */
export type SceneCanvasPreservedArrangementFields = {
  cards: ReadonlyMap<string, SceneCanvasPreservedCardFields>
  relations: ReadonlyMap<string, SceneCanvasDefaultRelation>
}

/** 一次读取得到的编排与保真快照；保真字段不进入协议。 */
export type SceneCanvasArrangementRead = {
  arrangement: SceneCanvasArrangementVO
  preserved: SceneCanvasPreservedArrangementFields
}

/** 按业务身份读写整份编排。不接受路径，不暴露持久化格式。 */
export interface SceneCanvasArrangementPersistenceGateway {
  /**
   * @returns 已保存编排与同一份文件的保真快照；确认不存在时为 null。
   * @throws {AppException} 编排损坏、格式不支持、归属不匹配或读取失败。
   */
  readArrangement(
    projectId: string,
    sceneId: string,
    canvasId: string
  ): Promise<SceneCanvasArrangementRead | null>

  /**
   * @param base - 与 arrangement 对应的同一次读取结果；没有已读文件时传 null。
   * 写入只合并 base 携带的保真字段，不再次读取既有文件。
   * @throws {AppException} 请求字段无效、序列化失败、路径越界或写入失败。失败不得留下半份目标文件。
   */
  writeArrangement(
    arrangement: SceneCanvasArrangementVO,
    base: SceneCanvasArrangementRead | null
  ): Promise<void>
}
