import type { VerifiedProjectReadLocation } from '../../models/ProjectInputSourceReadFacts'
import type { ProjectInputCatalogReadFact } from '../../models/ProjectInputCatalogReadFacts'
import type {
  CopyProjectFileDTO,
  CopyProjectFolderDTO,
  CreateProjectFolderDTO,
  CreateProjectTextFileDTO,
  DeleteProjectFolderDTO,
  MoveProjectFileDTO,
  ProjectFolderScopeDTO,
  RenameProjectFolderDTO,
  UpdateProjectTextFileBodyDTO
} from '../../dto/ProjectFilesDTO'
import type { ProjectFileOperationGateway } from '../../ports/ProjectFileOperationGateway'
import type { ProjectInputSourceReaderGateway } from '../../ports/ProjectInputSourceReaderGateway'
import type { ProjectWorkVersionGateway } from '../../ports/ProjectWorkVersionGateway'
import type { ProjectFolderDeletionPlanVO, ProjectFolderVO } from '../../vo/ProjectInputCatalogVO'
import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '../../vo/ProjectInputSourceVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import { evaluateFileMove } from '@domain/project-files/services/evaluateFileMove'
import {
  chooseFolderCopyName,
  evaluateFolderRename,
  namesInParent,
  requireFolderName
} from '@domain/project-files/services/folderNameRules'
import { chooseImportFileName } from '@domain/project-files/services/chooseImportFileName'
import { requireSingleFileName, splitFileName } from '@domain/project-files/services/fileNameFacts'
import { folderSubtree } from '@domain/project-files/services/validateProjectInputCatalog'
import { validateFolderCopyTarget } from '@domain/project-files/services/validateFolderCopyTarget'
import {
  toProjectInputSourceSummaryVO,
  toProjectInputSourceVO
} from '../../mapping/ProjectFilesViewMapper'

export type CatalogCommandDeps = {
  sources: ProjectInputSourceReaderGateway
  files: ProjectFileOperationGateway
  versions: ProjectWorkVersionGateway
  createSourceId: () => string
  createFolderId: () => string
  createFileId: () => string
  createOperationId: () => string
}

export async function createProjectTextFile(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: CreateProjectTextFileDTO
): Promise<ProjectInputSourceSummaryVO> {
  const catalog = await readCheckedCatalog(deps, project, request.expectedCatalogVersion)
  requireParent(catalog, request.parentFolderId)
  const extension = request.content.format === 'markdown' ? '.md' : '.txt'
  requireMatchingExtension(request.fileName, extension)
  requireBody(request.content.body)
  assertNameAvailable(catalog, request.parentFolderId, request.fileName)
  const sourceId = deps.createSourceId()
  const textChanges = await deps.files.prepareTextCreate(project, {
    sourceId,
    fileName: request.fileName,
    textKind: 'document',
    format: request.content.format,
    body: request.content.body
  })
  const catalogChanges = await deps.files.prepareCatalogWrite(
    project,
    nextCatalog(catalog, catalog.folders, place(catalog, sourceId, request.parentFolderId))
  )
  await publish(
    deps,
    project,
    [...textChanges, ...catalogChanges.changes],
    catalogChanges.watchedPaths,
    catalog.catalogVersion
  )
  return toProjectInputSourceSummaryVO(
    {
      sourceId,
      name: request.fileName,
      readable: true,
      contentKind: 'text',
      textKind: 'document'
    },
    request.parentFolderId
  )
}

export async function updateProjectTextFileBody(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: UpdateProjectTextFileBodyDTO
): Promise<ProjectInputSourceVO> {
  const changes = await deps.files.prepareTextUpdate(project, {
    sourceId: request.sourceId,
    body: request.content.body,
    expectedVersion: request.expectedSourceVersion
  })
  const catalog = await deps.sources.readProjectInputCatalog(project)
  await publish(deps, project, changes, [], catalog.catalogVersion)
  const fact = await deps.sources.readProjectInputSources(project, [request.sourceId])
  const source = fact.sources.find((item) => item.sourceId === request.sourceId)
  if (fact.projectId !== project.projectId || !source) {
    throw new AppException({
      code: ProjectFileErrorCodes.sourceSetMismatch,
      msg: '读取到的来源与请求不一致'
    })
  }
  return toProjectInputSourceVO(source)
}

export async function createProjectFolder(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: CreateProjectFolderDTO
): Promise<ProjectFolderVO> {
  const catalog = await readCheckedCatalog(deps, project, request.expectedCatalogVersion)
  requireParent(catalog, request.parentFolderId)
  requireFolderName(request.name)
  assertNameAvailable(catalog, request.parentFolderId, request.name)
  const folder: ProjectFolder = {
    folderId: deps.createFolderId(),
    parentFolderId: request.parentFolderId,
    name: request.name
  }
  await writeCatalog(
    deps,
    project,
    [...catalog.folders, folder],
    storedPlacements(catalog),
    catalog.catalogVersion
  )
  return folder
}

export async function copyProjectFile(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: CopyProjectFileDTO
): Promise<ProjectInputSourceSummaryVO> {
  requireOperationId(request.operationId)
  const catalog = await readCheckedCatalog(deps, project, request.expectedCatalogVersion)
  const source = requireSource(catalog, request.sourceId)
  if (!source.readable) {
    throw new AppException({ code: ProjectFileErrorCodes.contentDamaged, msg: '工程文件内容损坏' })
  }
  requireParent(catalog, request.targetFolderId)
  const fileName = chooseImportFileName(
    source.name,
    namesInParent(catalog.folders, catalog.sources, request.targetFolderId)
  )
  const newSourceId = deps.createSourceId()
  const copied = await deps.files.prepareFileCopy(project, {
    sourceId: source.sourceId,
    newSourceId,
    newFileId: deps.createFileId(),
    fileName
  })
  const catalogChanges = await deps.files.prepareCatalogWrite(
    project,
    nextCatalog(catalog, catalog.folders, place(catalog, newSourceId, request.targetFolderId))
  )
  await publish(
    deps,
    project,
    [...copied.changes, ...catalogChanges.changes],
    [...copied.watchedPaths, ...catalogChanges.watchedPaths],
    catalog.catalogVersion,
    request.operationId
  )
  return toProjectInputSourceSummaryVO(
    { ...source, sourceId: newSourceId, name: fileName, readable: true },
    request.targetFolderId
  )
}

/** 移动文件归属。目标与当前父目录相同时不提交。 */
export async function moveProjectFile(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: MoveProjectFileDTO
): Promise<ProjectInputSourceSummaryVO> {
  requireOperationId(request.operationId)
  const catalog = await readCheckedCatalog(deps, project, request.expectedCatalogVersion)
  const source = requireSource(catalog, request.sourceId)
  requireParent(catalog, request.targetFolderId)
  const decision = evaluateFileMove({
    currentParentFolderId: source.parentFolderId,
    expectedParentFolderId: request.expectedParentFolderId,
    targetFolderId: request.targetFolderId,
    fileName: source.name,
    occupiedNamesInTarget: namesInParent(catalog.folders, catalog.sources, request.targetFolderId)
  })
  if (!decision.changed) return toProjectInputSourceSummaryVO(source, source.parentFolderId)
  await writeCatalog(
    deps,
    project,
    catalog.folders,
    place(catalog, source.sourceId, request.targetFolderId),
    catalog.catalogVersion,
    request.operationId
  )
  return toProjectInputSourceSummaryVO(source, request.targetFolderId)
}

export async function copyProjectFolder(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: CopyProjectFolderDTO
): Promise<ProjectFolderVO> {
  requireOperationId(request.operationId)
  const catalog = await readCheckedCatalog(deps, project, request.expectedCatalogVersion)
  const root = requireFolder(catalog, request.folderId)
  requireParent(catalog, request.targetFolderId)
  validateFolderCopyTarget(catalog.folders, request.folderId, request.targetFolderId)
  const subtree = folderSubtree(catalog.folders, request.folderId)
  const folderIds = new Set(subtree.map((folder) => folder.folderId))
  const sources = catalog.sources.filter(
    (source) => source.parentFolderId !== null && folderIds.has(source.parentFolderId)
  )
  if (sources.some((source) => !source.readable)) {
    throw new AppException({ code: ProjectFileErrorCodes.contentDamaged, msg: '工程文件内容损坏' })
  }
  const folderIdsNext = new Map(subtree.map((folder) => [folder.folderId, deps.createFolderId()]))
  const topName = chooseFolderCopyName(
    root.name,
    namesInParent(catalog.folders, catalog.sources, request.targetFolderId)
  )
  const copiedFolders = subtree.map((folder) => ({
    folderId: folderIdsNext.get(folder.folderId) ?? folder.folderId,
    parentFolderId:
      folder.folderId === root.folderId
        ? request.targetFolderId
        : (folderIdsNext.get(folder.parentFolderId ?? '') ?? null),
    name: folder.folderId === root.folderId ? topName : folder.name
  }))
  const copies = sources.map((source) => ({
    sourceId: source.sourceId,
    newSourceId: deps.createSourceId(),
    newFileId: deps.createFileId(),
    fileName: source.name
  }))
  const copied = await deps.files.prepareSubtreeCopy(project, copies)
  const placements = [
    ...storedPlacements(catalog),
    ...copies
      .map((copy, index) => ({
        sourceId: copy.newSourceId,
        parentFolderId: folderIdsNext.get(sources[index]?.parentFolderId ?? '') ?? null
      }))
      .filter(
        (placement): placement is { sourceId: string; parentFolderId: string } =>
          placement.parentFolderId !== null
      )
  ]
  const catalogChanges = await deps.files.prepareCatalogWrite(project, {
    folders: [...catalog.folders, ...copiedFolders],
    placements
  })
  await publish(
    deps,
    project,
    [...copied.changes, ...catalogChanges.changes],
    [...copied.watchedPaths, ...catalogChanges.watchedPaths],
    catalog.catalogVersion,
    request.operationId
  )
  const created = copiedFolders[0]
  if (!created) {
    throw new AppException({ code: ProjectFileErrorCodes.folderMissing, msg: '文件夹不存在' })
  }
  return created
}

/** 重命名文件夹。名称未变化时不提交。 */
export async function renameProjectFolder(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: RenameProjectFolderDTO
): Promise<ProjectFolderVO> {
  const catalog = await readCheckedCatalog(deps, project, request.expectedCatalogVersion)
  const folder = requireFolder(catalog, request.folderId)
  const decision = evaluateFolderRename(
    folder.name,
    request.newName,
    namesInParent(catalog.folders, catalog.sources, folder.parentFolderId, folder.folderId)
  )
  if (!decision.changed) return folder
  const folders = catalog.folders.map((item) =>
    item.folderId === folder.folderId ? { ...item, name: decision.name } : item
  )
  await writeCatalog(deps, project, folders, storedPlacements(catalog), catalog.catalogVersion)
  return { ...folder, name: decision.name }
}

export async function readProjectFolderDeletionPlan(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: ProjectFolderScopeDTO
): Promise<ProjectFolderDeletionPlanVO> {
  return deps.sources.readFolderDeletionPlan(project, request.folderId)
}

export async function deleteProjectFolder(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  request: DeleteProjectFolderDTO
): Promise<void> {
  const plan = await deps.sources.readFolderDeletionPlan(project, request.folderId)
  if (plan.catalogVersion !== request.expectedCatalogVersion) throw versionChanged()
  if (plan.deletionVersion !== request.expectedDeletionVersion) {
    throw new AppException({
      code: ProjectFileErrorCodes.deletionPlanChanged,
      msg: '删除计划已变化，请重新核对'
    })
  }
  const catalog = await readCheckedCatalog(deps, project, plan.catalogVersion)
  const subtree = folderSubtree(catalog.folders, request.folderId)
  const folderIds = new Set(subtree.map((folder) => folder.folderId))
  const sourceIds = catalog.sources
    .filter((source) => source.parentFolderId !== null && folderIds.has(source.parentFolderId))
    .map((source) => source.sourceId)
  const prepared = await deps.files.prepareOwnedDeletes(project, sourceIds)
  const fresh = await deps.sources.readFolderDeletionPlan(project, request.folderId)
  if (fresh.deletionVersion !== plan.deletionVersion) {
    throw new AppException({
      code: ProjectFileErrorCodes.deletionPlanChanged,
      msg: '删除计划已变化，请重新核对'
    })
  }
  const remainingFolders = catalog.folders.filter((folder) => !folderIds.has(folder.folderId))
  const remainingPlacements = storedPlacements(catalog).filter(
    (placement) => !sourceIds.includes(placement.sourceId)
  )
  const catalogChanges = await deps.files.prepareCatalogWrite(project, {
    folders: remainingFolders,
    placements: remainingPlacements
  })
  await publish(
    deps,
    project,
    [...prepared.changes, ...catalogChanges.changes],
    [...prepared.watchedPaths, ...catalogChanges.watchedPaths],
    catalog.catalogVersion
  )
}

export async function readCheckedCatalog(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  expectedCatalogVersion: string
): Promise<ProjectInputCatalogReadFact> {
  const catalog = await deps.sources.readProjectInputCatalog(project)
  if (catalog.catalogVersion !== expectedCatalogVersion) throw versionChanged()
  return catalog
}

export function storedPlacements(
  catalog: ProjectInputCatalogReadFact
): { sourceId: string; parentFolderId: string }[] {
  return catalog.sources.flatMap((source) =>
    source.parentFolderId === null
      ? []
      : [{ sourceId: source.sourceId, parentFolderId: source.parentFolderId }]
  )
}

export function place(
  catalog: ProjectInputCatalogReadFact,
  sourceId: string,
  parentFolderId: string | null
): { sourceId: string; parentFolderId: string }[] {
  const rest = storedPlacements(catalog).filter((placement) => placement.sourceId !== sourceId)
  return parentFolderId === null ? rest : [...rest, { sourceId, parentFolderId }]
}

async function writeCatalog(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  folders: readonly ProjectFolder[],
  placements: readonly { sourceId: string; parentFolderId: string }[],
  expectedCatalogVersion: string,
  operationId?: string
): Promise<void> {
  const prepared = await deps.files.prepareCatalogWrite(project, { folders, placements })
  await publish(
    deps,
    project,
    prepared.changes,
    prepared.watchedPaths,
    expectedCatalogVersion,
    operationId
  )
}

async function publish(
  deps: CatalogCommandDeps,
  project: VerifiedProjectReadLocation,
  changes: readonly {
    relativePath: string
    action: 'add' | 'modify' | 'delete'
    bytes?: Uint8Array
    sourceFile?: string
  }[],
  watchedPaths: readonly string[],
  expectedCatalogVersion: string,
  operationId?: string
): Promise<void> {
  if (changes.length === 0) return
  await deps.versions.publish({
    project,
    operationId: operationId ?? deps.createOperationId(),
    changes,
    watchedPaths,
    expectedCatalogVersion
  })
}

function requireOperationId(operationId: string): void {
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作标识无效' })
  }
}

function requireParent(catalog: ProjectInputCatalogReadFact, parentFolderId: string | null): void {
  if (parentFolderId === null) return
  if (!catalog.folders.some((folder) => folder.folderId === parentFolderId)) {
    throw new AppException({ code: ProjectFileErrorCodes.folderMissing, msg: '文件夹不存在' })
  }
}

function requireSource(
  catalog: ProjectInputCatalogReadFact,
  sourceId: string
): ProjectInputCatalogReadFact['sources'][number] {
  const source = catalog.sources.find((item) => item.sourceId === sourceId)
  if (!source) {
    throw new AppException({
      code: ProjectFileErrorCodes.sourceRecordMissing,
      msg: '来源记录不存在'
    })
  }
  return source
}

function requireFolder(catalog: ProjectInputCatalogReadFact, folderId: string): ProjectFolder {
  const folder = catalog.folders.find((item) => item.folderId === folderId)
  if (!folder) {
    throw new AppException({ code: ProjectFileErrorCodes.folderMissing, msg: '文件夹不存在' })
  }
  return folder
}

function assertNameAvailable(
  catalog: ProjectInputCatalogReadFact,
  parentFolderId: string | null,
  name: string
): void {
  const occupied = namesInParent(catalog.folders, catalog.sources, parentFolderId)
  if (occupied.some((item) => item.toLowerCase() === name.toLowerCase())) {
    throw new AppException({
      code: ProjectFileErrorCodes.fileNameConflict,
      msg: '该名称已被占用'
    })
  }
}

function requireMatchingExtension(fileName: string, extension: string): void {
  requireSingleFileName(fileName)
  const actual = splitFileName(fileName).extension
  if (actual?.toLowerCase() !== extension) {
    throw new AppException({
      code: ProjectFileErrorCodes.invalidFileName,
      msg: '文件名与所选格式不一致'
    })
  }
}

function requireBody(body: string): void {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new AppException({
      code: ProjectFileErrorCodes.blankSourceContent,
      msg: '正文不能为空'
    })
  }
}

function versionChanged(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.catalogVersionChanged,
    msg: '目录已变化，请重新核对'
  })
}

function nextCatalog(
  catalog: ProjectInputCatalogReadFact,
  folders: readonly ProjectFolder[],
  placements: readonly { sourceId: string; parentFolderId: string }[]
): {
  folders: readonly ProjectFolder[]
  placements: readonly { sourceId: string; parentFolderId: string }[]
} {
  void catalog
  return { folders, placements }
}
