import type { SceneCanvasSaveReason } from '../dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '../vo/SceneCanvasArrangementVO'

/**
 * 交给作品版本端口的保持请求。
 * 操作标识由应用层生成，只在后端流转，不进入前端请求或结果。
 */
export type SceneCanvasVersionKeepRequest = {
  projectId: string
  sceneId: string
  canvasId: string
  reason: SceneCanvasSaveReason
  arrangement: SceneCanvasArrangementVO
  operationId: string
}

/**
 * 版本端口可映射的结算事实。
 * 这不是提交与回滚模块的协议，只供本模块区分已保持、确定失败和结果不明。
 */
export type SceneCanvasVersionSettlement = {
  state: 'kept' | 'uncommitted' | 'failed' | 'unknown'
}

/**
 * 已保持编排的后端版本事实。
 * 不进入前端保存结果，也不代替作品修订身份。
 */
export type SceneCanvasArrangementVersion = {
  projectId: string
  sceneId: string
  canvasId: string
  arrangementVersion: string
}
