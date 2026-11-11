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

export interface SceneCanvasClient {
  /** 读取已保存编排。没有文件时 data 为 null。 */
  readSceneCanvasArrangement(
    request: ReadSceneCanvasArrangementDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO | null>>
  createSourceCard(
    request: CreateSceneCanvasSourceCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  createPromptCard(
    request: CreateSceneCanvasPromptCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  createFieldCard(
    request: CreateSceneCanvasFieldCardDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editCard(request: EditSceneCanvasCardDTO): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editPromptBody(
    request: EditSceneCanvasPromptBodyDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  bindFieldCardPreset(
    request: BindSceneCanvasFieldCardPresetDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editMediaRole(
    request: EditSceneCanvasMediaRoleDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  copyCard(request: CopySceneCanvasCardDTO): Promise<AjaxResult<SceneCanvasArrangementVO>>
  deleteCard(request: DeleteSceneCanvasCardDTO): Promise<AjaxResult<SceneCanvasArrangementVO>>
  connectCards(request: ConnectSceneCanvasCardsDTO): Promise<AjaxResult<SceneCanvasArrangementVO>>
  disconnectCards(
    request: DisconnectSceneCanvasCardsDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  editRelationName(
    request: EditSceneCanvasRelationNameDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  attachRelationRecord(
    request: AttachSceneCanvasRelationRecordDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  detachRelationRecord(
    request: DetachSceneCanvasRelationRecordDTO
  ): Promise<AjaxResult<SceneCanvasArrangementVO>>
  /** 保存编排。成功 data 为 null。 */
  saveSceneCanvasArrangement(request: SaveSceneCanvasArrangementDTO): Promise<AjaxResult<null>>
}
