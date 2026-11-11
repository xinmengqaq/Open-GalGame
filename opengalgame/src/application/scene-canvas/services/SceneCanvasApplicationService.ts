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
  /**
   * @returns 已保存编排；没有已保存编排时为 null。不能用 null 表示损坏。
   * @throws {AppException} 编排损坏、归属不匹配或读取失败。
   */
  readSceneCanvasArrangement(
    request: ReadSceneCanvasArrangementDTO
  ): Promise<SceneCanvasArrangementVO | null>

  /**
   * @throws {AppException} 来源缺失、不可读，或草稿不合法。
   */
  createSourceCard(request: CreateSceneCanvasSourceCardDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @returns 正文为空的下一份编排。
   * @throws {AppException} 草稿身份不一致或布局不合法。
   */
  createPromptCard(request: CreateSceneCanvasPromptCardDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @returns 尚未绑定预设的下一份编排。
   * @throws {AppException} 类别或草稿不合法。
   */
  createFieldCard(request: CreateSceneCanvasFieldCardDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @throws {AppException} 卡片不存在，或字段不适用于该类别。
   */
  editCard(request: EditSceneCanvasCardDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @throws {AppException} 目标不是提示词卡。
   */
  editPromptBody(request: EditSceneCanvasPromptBodyDTO): Promise<SceneCanvasArrangementVO>

  /**
   * 绑定或清空动画、特效卡片的 WebGAL 字段。
   * @param request - 当前草稿和预设。空预设表示清空。
   * @throws {AppException} 目标不是字段卡，或绑定字段为空。
   */
  bindFieldCardPreset(request: BindSceneCanvasFieldCardPresetDTO): Promise<SceneCanvasArrangementVO>

  /**
   * 修改图片或音频卡的场景用途。
   * @throws {AppException} 目标不是对应媒体卡，或用途不属于该类别。
   */
  editMediaRole(request: EditSceneCanvasMediaRoleDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @returns 含新卡片、不含其关联的下一份编排。
   * @throws {AppException} 源卡片不存在。
   */
  copyCard(request: CopySceneCanvasCardDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @returns 下一份编排。不删除工程来源。
   * @throws {AppException} 卡片不存在。
   */
  deleteCard(request: DeleteSceneCanvasCardDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @throws {AppException} 自连、重复连线或端点不存在。
   */
  connectCards(request: ConnectSceneCanvasCardsDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @returns 下一份编排。不删除记录卡。
   * @throws {AppException} 关联不存在。
   */
  disconnectCards(request: DisconnectSceneCanvasCardsDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @param request - 关联身份和名称。空名称表示还没写关系。
   * @throws {AppException} 关联不存在。
   */
  editRelationName(request: EditSceneCanvasRelationNameDTO): Promise<SceneCanvasArrangementVO>

  /**
   * @throws {AppException} 记录类别不符，或提示词卡已装载到另一条关联。
   */
  attachRelationRecord(
    request: AttachSceneCanvasRelationRecordDTO
  ): Promise<SceneCanvasArrangementVO>

  /**
   * @returns 保留关联和记录卡的下一份编排。
   * @throws {AppException} 关联不存在。
   */
  detachRelationRecord(
    request: DetachSceneCanvasRelationRecordDTO
  ): Promise<SceneCanvasArrangementVO>

  /**
   * 落盘当前场景编排，并请求作品版本端口确认保持。
   * 成功仍无返回值。编排版本只留在后端版本端口，不进入前端结果。
   * @throws {AppException} 落盘失败、提交确定失败或提交结果不明。
   */
  saveSceneCanvasArrangement(request: SaveSceneCanvasArrangementDTO): Promise<void>
}
