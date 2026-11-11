import type { ProjectFilesApplicationService } from '@application/project-files/services/ProjectFilesApplicationService'
import type { ProjectInputSourceVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectApplicationService } from '@application/projects/services/ProjectApplicationService'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import type {
  SceneCanvasArrangement as SceneCanvasDomainArrangement,
  SceneCanvasCard as SceneCanvasDomainCard,
  SceneCanvasSourceCard
} from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import {
  bindSceneCanvasFieldPreset,
  copySceneCanvasCard,
  createSceneCanvasFieldCard,
  createSceneCanvasPromptCard,
  createSceneCanvasSourceCard,
  deleteSceneCanvasCard,
  editSceneCanvasCard,
  editSceneCanvasMediaRole,
  editSceneCanvasPromptBody
} from '@domain/scene-canvas/services/editSceneCanvasCards'
import {
  attachSceneCanvasRelationRecord,
  connectSceneCanvasCards,
  detachSceneCanvasRelationRecord,
  disconnectSceneCanvasCards,
  editSceneCanvasRelationName
} from '@domain/scene-canvas/services/editSceneCanvasRelations'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'
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
  SaveSceneCanvasArrangementDTO,
  SceneCanvasEditRequest
} from '../../dto/SceneCanvasDTO'
import type { SceneCanvasVersionSettlement } from '../../models/SceneCanvasSaveFacts'
import type { SceneCanvasArrangementPersistenceGateway } from '../../ports/SceneCanvasArrangementPersistenceGateway'
import type { SceneCanvasWorkVersionGateway } from '../../ports/SceneCanvasWorkVersionGateway'
import type { SceneCanvasApplicationService } from '../SceneCanvasApplicationService'
import type {
  SceneCanvasArrangementVO,
  SceneCanvasCardLayoutVO,
  SceneCanvasCardVO
} from '../../vo/SceneCanvasArrangementVO'

export interface SceneCanvasApplicationDependencies {
  sources: Pick<ProjectFilesApplicationService, 'readProjectInputSources'>
  persistence: SceneCanvasArrangementPersistenceGateway
  versions: SceneCanvasWorkVersionGateway
  workspace: Pick<ProjectApplicationService, 'inspectProjectWorkspace'>
  nextId: () => string
}

/** 编排场景画布编辑、读取和保存。不持有计时器，不实现版本协议。 */
export class SceneCanvasApplicationServiceImpl implements SceneCanvasApplicationService {
  private pendingOperationId: string | undefined

  constructor(private readonly deps: SceneCanvasApplicationDependencies) {}

  /** 读取已保存编排。确认没有文件时返回 null。 */
  async readSceneCanvasArrangement(
    request: ReadSceneCanvasArrangementDTO
  ): Promise<SceneCanvasArrangementVO | null> {
    const arrangement = await this.deps.persistence.readArrangement(
      request.projectId,
      request.sceneId,
      request.canvasId
    )
    if (arrangement === null) return null
    requireSameCanvas(request, arrangement)
    validateSceneCanvasArrangement(toDomain(arrangement))
    return toVO(toDomain(arrangement))
  }

  /** 按可读来源事实创建卡片，不复制正文或媒体。 */
  async createSourceCard(
    request: CreateSceneCanvasSourceCardDTO
  ): Promise<SceneCanvasArrangementVO> {
    requireSameCanvas(request, request.arrangement)
    const source = await this.readSource(request.projectId, request.sourceId)
    return this.finish(
      createSceneCanvasSourceCard(
        toDomain(request.arrangement),
        sourceCard(source, this.deps.nextId(), request.layout)
      )
    )
  }

  /** 创建没有来源身份的提示词卡片。 */
  createPromptCard(request: CreateSceneCanvasPromptCardDTO): Promise<SceneCanvasArrangementVO> {
    requireSameCanvas(request, request.arrangement)
    return Promise.resolve(
      this.finish(
        createSceneCanvasPromptCard(toDomain(request.arrangement), {
          kind: 'prompt',
          cardId: this.deps.nextId(),
          body: '',
          references: [],
          layout: request.layout
        })
      )
    )
  }

  /** 创建尚未选择预设的动画或特效卡片。 */
  createFieldCard(request: CreateSceneCanvasFieldCardDTO): Promise<SceneCanvasArrangementVO> {
    requireSameCanvas(request, request.arrangement)
    return Promise.resolve(
      this.finish(
        createSceneCanvasFieldCard(toDomain(request.arrangement), {
          kind: request.kind,
          cardId: this.deps.nextId(),
          webgalPreset: null,
          layout: request.layout
        })
      )
    )
  }

  editCard(request: EditSceneCanvasCardDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      editSceneCanvasCard(draft, request.cardId, {
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.summary === undefined ? {} : { summary: request.summary })
      })
    )
  }

  editPromptBody(request: EditSceneCanvasPromptBodyDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      editSceneCanvasPromptBody(draft, request.cardId, request.body)
    )
  }

  bindFieldCardPreset(
    request: BindSceneCanvasFieldCardPresetDTO
  ): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      bindSceneCanvasFieldPreset(draft, request.cardId, request.preset)
    )
  }

  editMediaRole(request: EditSceneCanvasMediaRoleDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      editSceneCanvasMediaRole(draft, request.cardId, request.role)
    )
  }

  copyCard(request: CopySceneCanvasCardDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      copySceneCanvasCard(draft, request.cardId, this.deps.nextId(), request.layout)
    )
  }

  deleteCard(request: DeleteSceneCanvasCardDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) => deleteSceneCanvasCard(draft, request.cardId))
  }

  connectCards(request: ConnectSceneCanvasCardsDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      connectSceneCanvasCards(draft, this.deps.nextId(), request.fromCardId, request.toCardId)
    )
  }

  disconnectCards(request: DisconnectSceneCanvasCardsDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) => disconnectSceneCanvasCards(draft, request.relationId))
  }

  editRelationName(request: EditSceneCanvasRelationNameDTO): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      editSceneCanvasRelationName(draft, request.relationId, request.specificName)
    )
  }

  attachRelationRecord(
    request: AttachSceneCanvasRelationRecordDTO
  ): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      attachSceneCanvasRelationRecord(draft, request.relationId, request.recordCardId)
    )
  }

  detachRelationRecord(
    request: DetachSceneCanvasRelationRecordDTO
  ): Promise<SceneCanvasArrangementVO> {
    return this.apply(request, (draft) =>
      detachSceneCanvasRelationRecord(draft, request.relationId)
    )
  }

  /**
   * 固定本次编排，必要时落盘，并请求版本端口确认保持。
   * 内容相同只能跳过落盘。操作标识只留在本进程，直到结算离开不明状态。
   */
  async saveSceneCanvasArrangement(request: SaveSceneCanvasArrangementDTO): Promise<void> {
    const arrangement = structuredClone(request.arrangement)
    requireSameCanvas(request, arrangement)
    validateSceneCanvasArrangement(toDomain(arrangement))
    await this.requirePreviousSettlement()
    await this.requireReadyWorkspace(request.projectId)
    const current = await this.deps.persistence.readArrangement(
      request.projectId,
      request.sceneId,
      request.canvasId
    )
    if (current === null || !sameArrangement(current, arrangement)) {
      try {
        await this.deps.persistence.writeArrangement(arrangement)
      } catch (error) {
        throw new AppException({
          code: SceneCanvasErrorCodes.persistFailed,
          msg: '编排没能写入',
          cause: error
        })
      }
    }
    const operationId = this.deps.nextId()
    let settlement: SceneCanvasVersionSettlement
    try {
      settlement = await this.deps.versions.keepArrangement({
        projectId: request.projectId,
        sceneId: request.sceneId,
        canvasId: request.canvasId,
        reason: request.reason,
        arrangement,
        operationId
      })
    } catch (error) {
      this.pendingOperationId = operationId
      throw new AppException({
        code: SceneCanvasErrorCodes.commitUnknown,
        msg: '编排提交结果尚未查明',
        cause: error
      })
    }
    if (settlement.state === 'kept') return
    if (settlement.state === 'unknown') {
      this.pendingOperationId = operationId
      throw new AppException({
        code: SceneCanvasErrorCodes.commitUnknown,
        msg: '编排提交结果尚未查明'
      })
    }
    throw new AppException({
      code: SceneCanvasErrorCodes.commitFailed,
      msg: '编排已落盘，但还没进入作品修订'
    })
  }

  private async apply(
    request: SceneCanvasEditRequest,
    change: (draft: SceneCanvasDomainArrangement) => SceneCanvasDomainArrangement
  ): Promise<SceneCanvasArrangementVO> {
    requireSameCanvas(request, request.arrangement)
    return this.finish(change(toDomain(request.arrangement)))
  }

  private finish(arrangement: SceneCanvasDomainArrangement): SceneCanvasArrangementVO {
    return toVO(arrangement)
  }

  private async requirePreviousSettlement(): Promise<void> {
    const operationId = this.pendingOperationId
    if (operationId === undefined) return
    let settlement: SceneCanvasVersionSettlement
    try {
      settlement = await this.deps.versions.readSettlement(operationId)
    } catch (error) {
      throw new AppException({
        code: SceneCanvasErrorCodes.commitUnknown,
        msg: '编排提交结果尚未查明',
        cause: error
      })
    }
    if (settlement.state === 'unknown') {
      throw new AppException({
        code: SceneCanvasErrorCodes.commitUnknown,
        msg: '编排提交结果尚未查明'
      })
    }
    this.pendingOperationId = undefined
  }

  /** 未就绪时停在写盘之前，避免变成已落盘未提交。 */
  private async requireReadyWorkspace(projectId: string): Promise<void> {
    const inspection = await this.deps.workspace.inspectProjectWorkspace({ projectId })
    if (inspection.ready) return
    throw new AppException({
      code: ProjectErrorCodes.workspaceNotReady,
      msg: '工程初始化未完成，请重新构建'
    })
  }

  private async readSource(projectId: string, sourceId: string): Promise<ProjectInputSourceVO> {
    try {
      const snapshot = await this.deps.sources.readProjectInputSources({
        projectId,
        sourceIds: [sourceId]
      })
      const source = snapshot.sources.find((item) => item.sourceId === sourceId)
      if (!source || snapshot.projectId !== projectId) {
        throw new AppException({
          code: SceneCanvasErrorCodes.sourceUnreadable,
          msg: '来源不可读取'
        })
      }
      return source
    } catch (error) {
      if (error instanceof AppException && error.code === SceneCanvasErrorCodes.sourceUnreadable) {
        throw error
      }
      throw new AppException({
        code: SceneCanvasErrorCodes.sourceUnreadable,
        msg: '来源不可读取',
        cause: error
      })
    }
  }
}

function sourceCard(
  source: ProjectInputSourceVO,
  cardId: string,
  layout: SceneCanvasCardLayoutVO
): SceneCanvasSourceCard {
  if (source.contentKind === 'text') {
    return {
      kind: 'document',
      cardId,
      sourceId: source.sourceId,
      title: source.title,
      summary: '',
      layout
    }
  }
  if (source.contentKind === 'audio') {
    return {
      kind: 'audio',
      cardId,
      sourceId: source.sourceId,
      role: 'music',
      title: source.name,
      summary: source.description,
      layout
    }
  }
  if (source.contentKind === 'image') {
    return {
      kind: 'image',
      cardId,
      sourceId: source.sourceId,
      role: 'background',
      title: source.name,
      summary: source.description,
      layout
    }
  }
  return {
    kind: 'video',
    cardId,
    sourceId: source.sourceId,
    title: source.name,
    summary: source.description,
    layout
  }
}

function requireSameCanvas(
  request: { projectId: string; sceneId: string; canvasId: string },
  arrangement: SceneCanvasArrangementVO
): void {
  if (
    request.projectId !== arrangement.projectId ||
    request.sceneId !== arrangement.sceneId ||
    request.canvasId !== arrangement.canvasId
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.identityMismatch,
      msg: '请求身份与编排身份不一致'
    })
  }
}

function toDomain(arrangement: SceneCanvasArrangementVO): SceneCanvasDomainArrangement {
  return {
    projectId: arrangement.projectId,
    sceneId: arrangement.sceneId,
    canvasId: arrangement.canvasId,
    viewport: { ...arrangement.viewport },
    cards: arrangement.cards.map(toDomainCard),
    relations: arrangement.relations.map((relation) => ({ ...relation }))
  }
}

function toDomainCard(card: SceneCanvasCardVO): SceneCanvasDomainCard {
  if (card.kind === 'audio') {
    return {
      kind: card.kind,
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'document') {
    return {
      kind: card.kind,
      cardId: card.cardId,
      sourceId: card.sourceId,
      title: card.title,
      summary: card.summary,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'image') {
    return {
      kind: card.kind,
      cardId: card.cardId,
      sourceId: card.sourceId,
      role: card.role,
      title: card.title,
      summary: card.summary,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'video') {
    return {
      kind: card.kind,
      cardId: card.cardId,
      sourceId: card.sourceId,
      title: card.title,
      summary: card.summary,
      layout: { ...card.layout }
    }
  }
  if (card.kind === 'prompt') {
    return {
      kind: 'prompt',
      cardId: card.cardId,
      body: card.body,
      references: card.references.map((reference) => ({ cardId: reference.cardId })),
      layout: { ...card.layout }
    }
  }
  return {
    kind: card.kind,
    cardId: card.cardId,
    webgalPreset: card.webgalPreset === null ? null : { ...card.webgalPreset },
    layout: { ...card.layout }
  }
}

function toVO(arrangement: SceneCanvasDomainArrangement): SceneCanvasArrangementVO {
  return toDomain(arrangement)
}

function sameArrangement(left: SceneCanvasArrangementVO, right: SceneCanvasArrangementVO): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])])
    )
  }
  return value
}
