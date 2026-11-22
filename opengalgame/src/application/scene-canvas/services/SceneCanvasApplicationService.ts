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
} from '../dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '../vo/SceneCanvasArrangementVO'

export interface SceneCanvasApplicationService {
  readSceneCanvasArrangement(
    request: ReadSceneCanvasArrangementDTO
  ): Promise<SceneCanvasArrangementVO | null>

  createSourceCard(request: CreateSceneCanvasSourceCardDTO): Promise<SceneCanvasArrangementVO>

  createPromptCard(request: CreateSceneCanvasPromptCardDTO): Promise<SceneCanvasArrangementVO>

  createFieldCard(request: CreateSceneCanvasFieldCardDTO): Promise<SceneCanvasArrangementVO>

  editCard(request: EditSceneCanvasCardDTO): Promise<SceneCanvasArrangementVO>

  editPromptBody(request: EditSceneCanvasPromptBodyDTO): Promise<SceneCanvasArrangementVO>

  bindFieldCardPreset(request: BindSceneCanvasFieldCardPresetDTO): Promise<SceneCanvasArrangementVO>

  editMediaRole(request: EditSceneCanvasMediaRoleDTO): Promise<SceneCanvasArrangementVO>

  copyCard(request: CopySceneCanvasCardDTO): Promise<SceneCanvasArrangementVO>

  deleteCard(request: DeleteSceneCanvasCardDTO): Promise<SceneCanvasArrangementVO>

  connectCards(request: ConnectSceneCanvasCardsDTO): Promise<SceneCanvasArrangementVO>

  disconnectCards(request: DisconnectSceneCanvasCardsDTO): Promise<SceneCanvasArrangementVO>

  editRelationName(request: EditSceneCanvasRelationNameDTO): Promise<SceneCanvasArrangementVO>

  attachRelationRecord(
    request: AttachSceneCanvasRelationRecordDTO
  ): Promise<SceneCanvasArrangementVO>

  detachRelationRecord(
    request: DetachSceneCanvasRelationRecordDTO
  ): Promise<SceneCanvasArrangementVO>

  saveSceneCanvasArrangement(request: SaveSceneCanvasArrangementDTO): Promise<void>
}
