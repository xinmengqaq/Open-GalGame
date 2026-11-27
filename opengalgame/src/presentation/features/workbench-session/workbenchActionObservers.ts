import type { ProjectInputContentKind } from '@application/project-files/vo/ProjectInputSourceVO'
import type { SceneCanvasCardVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'

import type { WorkbenchActionScope } from './actionObserverScope'
import type { WorkbenchExportActionObservers } from './exportActionObservers'
import type { WorkbenchGenerationActionObservers } from './generationActionObservers'
import type { WorkbenchPreviewActionObservers } from './previewActionObservers'

/** 事实发生时的工程/场景/画布；切走之后迟到的动作靠它被丢弃。 */
export type { WorkbenchActionScope }

/** 目录导入成功后的单个来源；app 层再筛出文档类来源。 */
export type ImportedSourceAction = {
  projectId: string
  sourceId: string
  contentKind: ProjectInputContentKind
}

export type ImportedSourcesHandler = (sources: readonly ImportedSourceAction[]) => void

export type CanvasCardAction = {
  scope: WorkbenchActionScope
  cardId: string
  cardKind: SceneCanvasCardVO['kind']
}

export type CardSelectedAction = {
  scope: WorkbenchActionScope
  cardId: string
  cardKind: SceneCanvasCardVO['kind']
}

/** 卡片删除成功；两端连线由服务端一并移除，由教程自行失效对应拍。 */
export type CardDeletedAction = {
  scope: WorkbenchActionScope
  cardId: string
  cardKind: SceneCanvasCardVO['kind']
}

export type DocumentOpenedAction = {
  scope: WorkbenchActionScope
  cardId: string
}

/** 文档编辑器实际关闭、回到画布；取消保存确认不会走到这里。 */
export type DocumentClosedAction = {
  scope: WorkbenchActionScope
  cardId: string
}

export type CardEditedAction = {
  scope: WorkbenchActionScope
  cardId: string
  cardKind: SceneCanvasCardVO['kind']
}

export type PromptBodySavedAction = {
  scope: WorkbenchActionScope
  cardId: string
}

/** 普通连线的两端；方向不表示先后，由新手引导按无向端点集匹配。 */
export type RelationAction = {
  scope: WorkbenchActionScope
  relationId: string
  fromCardId: string
  toCardId: string
  fromCardKind: SceneCanvasCardVO['kind']
  toCardKind: SceneCanvasCardVO['kind']
}

/** 只有手动保存会走到这里；周期保存和生成前保存由命令层直接过滤。 */
export type CanvasSavedAction = {
  scope: WorkbenchActionScope
}

export type InputSummaryOpenedAction = {
  scope: WorkbenchActionScope
}

/**
 * 工作台页面能上报的窄语义动作。
 *
 * 页面和 feature 只认识这些回调，不 import 新手引导；由 app 层的观察源把它们
 * 翻译成 GuideFact。所有回调都只在真实成功点触发，且携带动作发生时捕获的作用域。
 */
export interface WorkbenchActionObservers
  extends
    WorkbenchGenerationActionObservers,
    WorkbenchPreviewActionObservers,
    WorkbenchExportActionObservers {
  onSourceImported?: (source: ImportedSourceAction) => void
  onCardCreated?: (card: CanvasCardAction) => void
  /** 用户在当前画布明确选中一张已放置的卡；用于复用，不靠扫描同类卡。 */
  onCardSelected?: (card: CardSelectedAction) => void
  /** 卡片删除成功；教程据此解除已绑定的角色，不能继续用旧 ID 等待。 */
  onCardDeleted?: (card: CardDeletedAction) => void
  onDocumentOpened?: (event: DocumentOpenedAction) => void
  onDocumentClosed?: (event: DocumentClosedAction) => void
  onCardEdited?: (event: CardEditedAction) => void
  /** 提示词正文真正写入服务端后上报；本地草稿不触发。 */
  onPromptBodySaved?: (event: PromptBodySavedAction) => void
  onRelationCreated?: (event: RelationAction) => void
  onRelationNamed?: (event: RelationAction) => void
  /** 连线删除成功；保留两端身份，让教程回到对应拍重建。 */
  onRelationDeleted?: (event: RelationAction) => void
  onCanvasSaved?: (event: CanvasSavedAction) => void
  onInputSummaryOpened?: (event: InputSummaryOpenedAction) => void
  /** 试玩预览模态层的打开/关闭；教程据此隐藏，避免和舞台争夺焦点。 */
  onPreviewVisibilityChanged?: (open: boolean) => void
  /** 生成抽屉的打开/关闭；第 6 步候选就绪时教程据此收起，让出抽屉里的候选入口。 */
  onGenerationDrawerVisibilityChanged?: (open: boolean) => void
}
