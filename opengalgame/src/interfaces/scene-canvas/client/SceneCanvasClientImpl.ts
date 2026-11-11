import type {
  AttachSceneCanvasRelationRecordDTO,
  BindSceneCanvasFieldCardPresetDTO,
  ConnectSceneCanvasCardsDTO,
  CopySceneCanvasCardDTO,
  CreateSceneCanvasFieldCardDTO,
  CreateSceneCanvasPromptCardDTO,
  CreateSceneCanvasSourceCardDTO,
  DeleteSceneCanvasCardDTO,
  DetachSceneCanvasRelationRecordDTO,
  DisconnectSceneCanvasCardsDTO,
  EditSceneCanvasCardDTO,
  EditSceneCanvasMediaRoleDTO,
  EditSceneCanvasPromptBodyDTO,
  EditSceneCanvasRelationNameDTO,
  ReadSceneCanvasArrangementDTO,
  SaveSceneCanvasArrangementDTO
} from '@application/scene-canvas/dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseSceneCanvasArrangementResult,
  parseSceneCanvasReadResult,
  parseSceneCanvasSaveResult
} from '../contracts/SceneCanvasResponseSchema'
import type { SceneCanvasClient } from './SceneCanvasClient'

/**
 * 把未知桥接结果收成已校验响应。传输中断或结构不符时返回通信失败。
 * @returns 校验后的响应，或安全通信失败。
 */
async function readSceneCanvasResult<T>(
  action: () => Promise<unknown>,
  parse: (value: unknown) => AjaxResult<T> | null
): Promise<AjaxResult<T>> {
  try {
    const result = parse(await action())
    return result ?? communicationFailureResult()
  } catch {
    return communicationFailureResult()
  }
}

export class SceneCanvasClientImpl implements SceneCanvasClient {
  /**
   * @param bridge - 与主进程通信的固定桥接。
   */
  constructor(private readonly bridge: DesktopBridge) {}

  readSceneCanvasArrangement(
    request: ReadSceneCanvasArrangementDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO | null>> {
    return readSceneCanvasResult(
      () => this.bridge.readSceneCanvasArrangement(request),
      parseSceneCanvasReadResult
    )
  }

  createSourceCard(
    request: CreateSceneCanvasSourceCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.createSceneCanvasSourceCard(request),
      parseSceneCanvasArrangementResult
    )
  }

  createPromptCard(
    request: CreateSceneCanvasPromptCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.createSceneCanvasPromptCard(request),
      parseSceneCanvasArrangementResult
    )
  }

  createFieldCard(
    request: CreateSceneCanvasFieldCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.createSceneCanvasFieldCard(request),
      parseSceneCanvasArrangementResult
    )
  }

  editCard(request: EditSceneCanvasCardDTO): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.editSceneCanvasCard(request),
      parseSceneCanvasArrangementResult
    )
  }

  editPromptBody(
    request: EditSceneCanvasPromptBodyDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.editSceneCanvasPromptBody(request),
      parseSceneCanvasArrangementResult
    )
  }

  bindFieldCardPreset(
    request: BindSceneCanvasFieldCardPresetDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.bindSceneCanvasFieldCardPreset(request),
      parseSceneCanvasArrangementResult
    )
  }

  editMediaRole(
    request: EditSceneCanvasMediaRoleDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.editSceneCanvasMediaRole(request),
      parseSceneCanvasArrangementResult
    )
  }

  copyCard(request: CopySceneCanvasCardDTO): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.copySceneCanvasCard(request),
      parseSceneCanvasArrangementResult
    )
  }

  deleteCard(request: DeleteSceneCanvasCardDTO): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.deleteSceneCanvasCard(request),
      parseSceneCanvasArrangementResult
    )
  }

  connectCards(request: ConnectSceneCanvasCardsDTO): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.connectSceneCanvasCards(request),
      parseSceneCanvasArrangementResult
    )
  }

  disconnectCards(
    request: DisconnectSceneCanvasCardsDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.disconnectSceneCanvasCards(request),
      parseSceneCanvasArrangementResult
    )
  }

  editRelationName(
    request: EditSceneCanvasRelationNameDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.editSceneCanvasRelationName(request),
      parseSceneCanvasArrangementResult
    )
  }

  attachRelationRecord(
    request: AttachSceneCanvasRelationRecordDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.attachSceneCanvasRelationRecord(request),
      parseSceneCanvasArrangementResult
    )
  }

  detachRelationRecord(
    request: DetachSceneCanvasRelationRecordDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>> {
    return readSceneCanvasResult(
      () => this.bridge.detachSceneCanvasRelationRecord(request),
      parseSceneCanvasArrangementResult
    )
  }

  saveSceneCanvasArrangement(request: SaveSceneCanvasArrangementDTO): Promise<AjaxResult<null>> {
    return readSceneCanvasResult(
      () => this.bridge.saveSceneCanvasArrangement(request),
      parseSceneCanvasSaveResult
    )
  }
}
