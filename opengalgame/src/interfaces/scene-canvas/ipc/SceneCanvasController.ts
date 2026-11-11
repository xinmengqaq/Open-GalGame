import type { SceneCanvasApplicationService } from '@application/scene-canvas/services/SceneCanvasApplicationService'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  attachSceneCanvasRelationRecordSchema,
  bindSceneCanvasFieldCardPresetSchema,
  connectSceneCanvasCardsSchema,
  copySceneCanvasCardSchema,
  createSceneCanvasFieldCardSchema,
  createSceneCanvasPromptCardSchema,
  createSceneCanvasSourceCardSchema,
  deleteSceneCanvasCardSchema,
  detachSceneCanvasRelationRecordSchema,
  disconnectSceneCanvasCardsSchema,
  editSceneCanvasCardSchema,
  editSceneCanvasMediaRoleSchema,
  editSceneCanvasPromptBodySchema,
  editSceneCanvasRelationNameSchema,
  readSceneCanvasArrangementSchema,
  saveSceneCanvasArrangementSchema
} from './SceneCanvasRequestSchema'

export class SceneCanvasController {
  private readonly handle: IpcRequestHandler

  /**
   * @param exceptions - 统一失败出口。
   */
  constructor(
    private readonly sceneCanvas: SceneCanvasApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  /**
   * @returns 编排或 null。
   */
  readSceneCanvasArrangement(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO | null>> {
    return this.handle(
      readSceneCanvasArrangementSchema,
      input,
      access,
      '画布编排读取完成',
      (request) => this.sceneCanvas.readSceneCanvasArrangement(request)
    )
  }

  createSourceCard(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      createSceneCanvasSourceCardSchema,
      input,
      access,
      '来源卡片已创建',
      (request) => this.sceneCanvas.createSourceCard(request)
    )
  }

  createPromptCard(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      createSceneCanvasPromptCardSchema,
      input,
      access,
      '提示词卡片已创建',
      (request) => this.sceneCanvas.createPromptCard(request)
    )
  }

  createFieldCard(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      createSceneCanvasFieldCardSchema,
      input,
      access,
      '字段卡片已创建',
      (request) => this.sceneCanvas.createFieldCard(request)
    )
  }

  editCard(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(editSceneCanvasCardSchema, input, access, '卡片已更新', (request) =>
      this.sceneCanvas.editCard(request)
    )
  }

  editPromptBody(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(editSceneCanvasPromptBodySchema, input, access, '提示词已更新', (request) =>
      this.sceneCanvas.editPromptBody(request)
    )
  }

  bindFieldCardPreset(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      bindSceneCanvasFieldCardPresetSchema,
      input,
      access,
      '字段绑定已更新',
      (request) => this.sceneCanvas.bindFieldCardPreset(request)
    )
  }

  editMediaRole(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      editSceneCanvasMediaRoleSchema,
      input,
      access,
      '素材用途已更新',
      (request) => this.sceneCanvas.editMediaRole(request)
    )
  }

  copyCard(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(copySceneCanvasCardSchema, input, access, '卡片已复制', (request) =>
      this.sceneCanvas.copyCard(request)
    )
  }

  deleteCard(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(deleteSceneCanvasCardSchema, input, access, '卡片已删除', (request) =>
      this.sceneCanvas.deleteCard(request)
    )
  }

  connectCards(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(connectSceneCanvasCardsSchema, input, access, '卡片已连接', (request) =>
      this.sceneCanvas.connectCards(request)
    )
  }

  disconnectCards(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(disconnectSceneCanvasCardsSchema, input, access, '关联已删除', (request) =>
      this.sceneCanvas.disconnectCards(request)
    )
  }

  editRelationName(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      editSceneCanvasRelationNameSchema,
      input,
      access,
      '关系名称已更新',
      (request) => this.sceneCanvas.editRelationName(request)
    )
  }

  attachRelationRecord(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      attachSceneCanvasRelationRecordSchema,
      input,
      access,
      '关系记录已装载',
      (request) => this.sceneCanvas.attachRelationRecord(request)
    )
  }

  detachRelationRecord(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return this.handle(
      detachSceneCanvasRelationRecordSchema,
      input,
      access,
      '关系记录已卸下',
      (request) => this.sceneCanvas.detachRelationRecord(request)
    )
  }

  /**
   * 保存编排。应用服务没有返回值，成功响应 data 为 null。
   * @returns 成功时 data 为 null。
   */
  saveSceneCanvasArrangement(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(
      saveSceneCanvasArrangementSchema,
      input,
      access,
      '场景编排已保持',
      async (request) => {
        await this.sceneCanvas.saveSceneCanvasArrangement(request)
        return null
      }
    )
  }
}
