import type { SceneGenerationProductionContext } from '@application/scene-generation/ports/SceneGenerationProductionContext'
import type { SceneInputGateway } from '@application/scene-generation/ports/SceneInputGateway'
import type {
  SceneConfirmedControlDTO,
  SceneGenerationInputsDTO,
  SceneGenerationPromptScopeDTO,
  SceneInputSelectionDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasCard,
  SceneCanvasRelation
} from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { validateSceneCanvasArrangement } from '@domain/scene-canvas/services/validateSceneCanvasArrangement'
import { identifyMediaFormat } from '@infrastructure/media/identifyMediaFormat'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION,
  sceneCanvasArrangementDocumentSchema as currentArrangementDocumentSchema,
  sceneCanvasArrangementFormatProbeSchema
} from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import { toArrangementVersion } from '@infrastructure/scene-canvas/mapping/SceneCanvasArrangementReadFactsMapper'
import {
  copyUsage,
  currentDocumentToModel
} from '@infrastructure/scene-canvas/sceneArrangementCurrentMapping'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'
import type { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
import { projectInputSourceDocumentSchema } from '@infrastructure/project-files/documents/ProjectInputSourceDocument'
import {
  documentBodyPath,
  encodeStorageKey,
  sourceDescriptorPath,
  withProjectFileRead,
  type ProjectFileReadWindow
} from '@infrastructure/project-files/public/projectFileStorage'
import { parseJsonDocumentContent } from '@infrastructure/storage/jsonDocument'
import { sourceLocationSchema } from '../execution/SceneGenerationExecutionDocument'

export type SceneGenerationRegistration = {
  source: SceneSourceLocation
}

type LoadedDocument = {
  kind: 'document'
  sourceId: string
  body: string
  topics: readonly string[]
}

type LoadedAsset = {
  kind: 'asset'
  sourceId: string
  relativePath: string
  fileType: 'image' | 'audio' | 'video'
}

type LoadedSource = LoadedDocument | LoadedAsset

export class SceneInputGatewayImpl implements SceneInputGateway {
  private readonly registrations: readonly SceneGenerationRegistration[]

  constructor(
    registrations: readonly SceneGenerationRegistration[],
    private readonly migration: CanvasArrangementMigration,
    private readonly production?: SceneGenerationProductionContext
  ) {
    this.registrations = registrations.map((item) => {
      const source = sourceLocationSchema.safeParse(item.source)
      if (!source.success) {
        throw new AppException({
          code: ErrorCodes.invalidRequest,
          msg: '场景生成登记输入格式无效',
          cause: source.error
        })
      }
      return { source: source.data }
    })
  }

  async locateScene(scene: { projectId: string; sceneId: string }): Promise<SceneSourceLocation> {
    const registration = this.registrations.find(
      (item) => item.source.projectId === scene.projectId && item.source.sceneId === scene.sceneId
    )
    if (registration) {
      await resolveContained(
        registration.source.projectRoot,
        `${registration.source.sceneDirectory}/${registration.source.entryFile}`
      )
      return structuredClone(registration.source)
    }
    if (!this.production) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '当前工程场景未登记' })
    }
    return structuredClone(await this.production.resolveRegisteredScene(scene))
  }

  async readInputs(
    source: SceneSourceLocation,
    selection: SceneInputSelectionDTO
  ): Promise<SceneGenerationInputsDTO> {
    const located = await this.locateScene(source)
    if (located.projectRoot !== source.projectRoot) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '输入工程归属不匹配' })
    }
    try {
      await this.migration.ensureCurrent({
        projectId: located.projectId,
        directory: located.projectRoot,
        sceneId: located.sceneId,
        canvasId: selection.canvasId,
        trigger: 'generation'
      })
    } catch {
    }
    return withProjectFileRead(source.projectRoot, source.projectId, async (window) => {
      const current = await readArrangement(window, source.sceneId, selection.canvasId)
      const sources = await readCardSources(window, source.projectRoot, current.arrangement.cards)
      return assembleInputs(
        current.arrangement,
        current.arrangementVersion,
        sources,
        selection.confirmedControls
      )
    })
  }
}

async function readArrangement(
  window: ProjectFileReadWindow,
  sceneId: string,
  canvasId: string
): Promise<{ arrangement: SceneCanvasArrangement; arrangementVersion: string }> {
  if (sceneId.trim() === '' || canvasId.trim() === '') {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '画布身份不能为空' })
  }
  const relativePath = arrangementPath(sceneId, canvasId)
  const file = await window.readOptionalUnboundedText(relativePath)
  if (file === null) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '已保存编排不存在' })
  }
  const value = parseJsonDocumentContent(file.text, {
    code: SceneCanvasErrorCodes.contentDamaged,
    msg: '编排内容损坏'
  })
  const probe = sceneCanvasArrangementFormatProbeSchema.safeParse(value)
  if (!probe.success || typeof probe.data.formatVersion !== 'number') {
    throw new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏'
    })
  }
  if (probe.data.formatVersion !== SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION) {
    throw new AppException({
      code: SceneCanvasErrorCodes.unsupportedFormat,
      msg: '编排格式不受支持'
    })
  }
  const parsed = currentArrangementDocumentSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏',
      cause: parsed.error
    })
  }
  assertArrangementOwnership(parsed.data, window, sceneId, canvasId)
  const arrangement = currentDocumentToModel(parsed.data)
  try {
    validateSceneCanvasArrangement(arrangement, { promptReferences: false })
  } catch (error) {
    throw new AppException({
      code: SceneCanvasErrorCodes.contentDamaged,
      msg: '编排内容损坏',
      cause: error
    })
  }
  return {
    arrangement,
    arrangementVersion: toArrangementVersion(window.projectId, sceneId, canvasId, file.digest)
  }
}

function assertArrangementOwnership(
  document: { projectId: string; sceneId: string; canvasId: string },
  window: ProjectFileReadWindow,
  sceneId: string,
  canvasId: string
): void {
  if (
    document.projectId !== window.projectId ||
    document.sceneId !== sceneId ||
    document.canvasId !== canvasId
  ) {
    throw new AppException({
      code: SceneCanvasErrorCodes.ownershipMismatch,
      msg: '工程文件归属不匹配'
    })
  }
}

async function readCardSources(
  window: ProjectFileReadWindow,
  projectRoot: string,
  cards: readonly SceneCanvasCard[]
): Promise<ReadonlyMap<string, LoadedSource>> {
  const loaded = new Map<string, LoadedSource>()
  for (const card of cards) {
    if (
      card.kind !== 'document' &&
      card.kind !== 'image' &&
      card.kind !== 'audio' &&
      card.kind !== 'video'
    ) {
      continue
    }
    const existing = loaded.get(card.sourceId)
    if (existing) {
      assertSourceMatchesCard(existing, card.kind)
      continue
    }
    const source = await readSource(window, projectRoot, card.sourceId)
    assertSourceMatchesCard(source, card.kind)
    loaded.set(card.sourceId, source)
  }
  return loaded
}

function assertSourceMatchesCard(source: LoadedSource, kind: SceneCanvasCard['kind']): void {
  const expected =
    kind === 'document'
      ? 'document'
      : kind === 'image'
        ? 'image'
        : kind === 'audio'
          ? 'audio'
          : 'video'
  const actual = source.kind === 'document' ? 'document' : source.fileType
  if (actual !== expected) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '素材的真实类型与用途不符或无法识别'
    })
  }
}

async function readSource(
  window: ProjectFileReadWindow,
  projectRoot: string,
  sourceId: string
): Promise<LoadedSource> {
  const descriptor = await window.readOptionalText(sourceDescriptorPath(sourceId))
  if (descriptor === null) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '选择的创作输入不存在' })
  }
  let value: unknown
  try {
    value = parseJsonDocumentContent(descriptor.text, {
      code: ProjectFileErrorCodes.contentDamaged,
      msg: '工程文件内容损坏'
    })
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '素材文件无法读取',
      cause: error
    })
  }
  const document = projectInputSourceDocumentSchema.safeParse(value)
  if (
    !document.success ||
    document.data.projectId !== window.projectId ||
    document.data.sourceId !== sourceId
  ) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材文件无法读取' })
  }
  if (document.data.content.kind === 'document') {
    const extension = document.data.content.importFormat === 'markdown' ? 'md' : 'txt'
    if (document.data.content.bodyFile !== `${encodeStorageKey(sourceId)}.${extension}`) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材文件无法读取' })
    }
    const bodyFile = await window.readOptionalBytes(documentBodyPath(sourceId, extension))
    if (bodyFile === null) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材文件无法读取' })
    }
    let body: string
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(bodyFile.bytes)
    } catch (error) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '素材文件无法读取',
        cause: error
      })
    }
    return {
      kind: 'document',
      sourceId,
      body,
      topics: document.data.content.topics
    }
  }
  await resolveContained(projectRoot, document.data.content.mediaPath)
  const bytes = await window.readOptionalBytes(document.data.content.mediaPath)
  if (bytes === null) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材文件无法读取' })
  }
  const identification = await identifyMediaFormat(bytes.bytes)
  const category = identification.supported ? identification.category : undefined
  if (category !== document.data.content.fileType) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: `素材“${document.data.content.name}”的真实类型与用途不符或无法识别`
    })
  }
  return {
    kind: 'asset',
    sourceId,
    relativePath: document.data.content.mediaPath,
    fileType: document.data.content.fileType
  }
}

function assembleInputs(
  arrangement: SceneCanvasArrangement,
  arrangementVersion: string,
  sources: ReadonlyMap<string, LoadedSource>,
  confirmedControls: readonly SceneConfirmedControlDTO[]
): SceneGenerationInputsDTO {
  const documents = arrangement.cards.flatMap((card) => {
    if (card.kind !== 'document') return []
    const source = sources.get(card.sourceId)
    if (!source || source.kind !== 'document') {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '选择的创作输入不存在' })
    }
    return [
      {
        id: card.cardId,
        sourceId: card.sourceId,
        title: card.title,
        summary: card.summary,
        body: source.body,
        topics: [...source.topics],
        usage: copyUsage(card.usage)
      }
    ]
  })
  const prompts = arrangement.cards.flatMap((card) => {
    if (card.kind !== 'prompt') return []
    if (card.title.trim() === '') {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提示词标题不能为空' })
    }
    if (card.body.trim() === '') {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '提示词正文不能为空' })
    }
    return [
      {
        id: card.cardId,
        title: card.title,
        body: card.body,
        scopes: promptScopes(card.cardId, arrangement.relations),
        references: promptReferences(card, arrangement.cards),
        usage: copyUsage(card.usage)
      }
    ]
  })
  const assets = arrangement.cards.flatMap((card) => {
    if (card.kind !== 'image' && card.kind !== 'audio' && card.kind !== 'video') return []
    const source = sources.get(card.sourceId)
    if (!source || source.kind !== 'asset') {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '选择的创作输入不存在' })
    }
    return [
      {
        assetId: card.cardId,
        sourceId: card.sourceId,
        name: card.title,
        relativePath: source.relativePath,
        category: card.kind,
        description: card.summary,
        usage: copyUsage(card.usage)
      }
    ]
  })
  const fieldBindings = arrangement.cards.flatMap((card) => {
    if (card.kind !== 'animation' && card.kind !== 'effect') return []
    return [
      {
        cardId: card.cardId,
        kind: card.kind,
        command: card.webgalPreset?.command ?? null,
        name: card.webgalPreset?.name ?? null,
        usage: copyUsage(card.usage)
      }
    ]
  })
  const textIds = new Set([...documents.map((item) => item.id), ...prompts.map((item) => item.id)])
  for (const control of confirmedControls) {
    if (control.content.trim() === '' || !textIds.has(control.inputId)) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '已确认控制必须指向本次文档或提示词'
      })
    }
  }
  return {
    canvasId: arrangement.canvasId,
    arrangementVersion,
    assets,
    documents,
    prompts,
    fieldBindings,
    relations: arrangement.relations.map((relation) => ({
      relationId: relation.relationId,
      fromCardId: relation.fromCardId,
      toCardId: relation.toCardId,
      defaultRelation: relation.defaultRelation,
      specificName: relation.specificName,
      record: relationRecord(relation, arrangement.cards)
    })),
    confirmedControls: confirmedControls.map((control) => ({ ...control }))
  }
}

function promptReferences(
  prompt: SceneCanvasCard & { kind: 'prompt' },
  cards: readonly SceneCanvasCard[]
): SceneGenerationInputsDTO['prompts'][number]['references'] {
  const seen = new Set<string>()
  return prompt.references.map((reference) => {
    if (seen.has(reference.cardId)) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '同一提示词不能重复引用同一卡片',
        reason: FailureReasons.promptReferenceDuplicate
      })
    }
    seen.add(reference.cardId)
    const target = cards.find((card) => card.cardId === reference.cardId)
    if (!target || target.cardId === prompt.cardId || target.kind === 'prompt') {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '提示词引用的卡片不在当前画布或无法读取',
        reason: FailureReasons.promptReferenceTargetMissing
      })
    }
    return {
      cardId: target.cardId,
      kind: target.kind,
      displayName: target.title
    }
  })
}

function relationRecord(
  relation: SceneCanvasRelation,
  cards: readonly SceneCanvasCard[]
): SceneGenerationInputsDTO['relations'][number]['record'] {
  if (relation.recordCardId === null) return null
  const card = cards.find((item) => item.cardId === relation.recordCardId)
  if (!card || (card.kind !== 'document' && card.kind !== 'prompt')) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '卡片关联无效' })
  }
  if (card.kind === 'prompt') return { kind: 'prompt', cardId: card.cardId }
  return { kind: 'document', cardId: card.cardId, sourceId: card.sourceId }
}

function promptScopes(
  cardId: string,
  relations: readonly SceneCanvasRelation[]
): SceneGenerationPromptScopeDTO[] {
  const ordinary = relations.filter(
    (relation) => relation.fromCardId === cardId || relation.toCardId === cardId
  )
  const records = relations.filter((relation) => relation.recordCardId === cardId)
  const scopes: SceneGenerationPromptScopeDTO[] = []
  if (ordinary.length > 0) {
    scopes.push({
      kind: 'cards',
      cardIds: [
        ...new Set(
          ordinary.map((relation) =>
            relation.fromCardId === cardId ? relation.toCardId : relation.fromCardId
          )
        )
      ]
    })
  }
  for (const relation of records) scopes.push({ kind: 'relation', relationId: relation.relationId })
  if (scopes.length === 0) scopes.push({ kind: 'scene' })
  return scopes
}
