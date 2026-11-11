import type { ImportProjectFilesDTO } from '@application/project-files/dto/ProjectFilesDTO'
import type {
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type {
  ImportProjectFilesVO,
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  readWorkbenchFixtureMode,
  workbenchSourceDetails,
  workbenchSourceFolders,
  workbenchSourceSummaries
} from './workbenchFixtures'

type FixtureCatalog = {
  catalogVersion: string
  folders: ProjectFolderVO[]
  sources: ProjectInputSourceSummaryVO[]
}

type ImportedKind =
  { contentKind: 'text'; textKind: 'document' } | { contentKind: 'image' | 'audio' | 'video' }

const catalogs = new Map<string, FixtureCatalog>()
let importedSourceCount = 0

/** 当前工程的可写夹具目录。空场景从空目录开始，其余从演示目录复制。 */
function catalogOf(projectId: string): FixtureCatalog {
  const existing = catalogs.get(projectId)
  if (existing) return existing
  const created: FixtureCatalog =
    readWorkbenchFixtureMode() === 'empty'
      ? { catalogVersion: 'empty', folders: [], sources: [] }
      : {
          catalogVersion: 'fixture',
          folders: workbenchSourceFolders.map((folder) => ({ ...folder })),
          sources: workbenchSourceSummaries.map((source) => ({ ...source }))
        }
  catalogs.set(projectId, created)
  return created
}

export function fixtureListSources(projectId: string): AjaxResult<ProjectInputCatalogVO> {
  if (readWorkbenchFixtureMode() === 'fail') {
    return { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取工程文件' }
  }
  const catalog = catalogOf(projectId)
  return {
    code: ErrorCodes.success,
    msg: '来源列表读取成功',
    data: {
      projectId,
      catalogVersion: catalog.catalogVersion,
      folders: catalog.folders,
      sources: catalog.sources
    }
  }
}

export function fixturePathForDroppedFile(file: File): AjaxResult<string> {
  if (readWorkbenchFixtureMode() === 'fail') {
    return { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取工程文件' }
  }
  const name = file.name.trim()
  if (!name) return { code: ErrorCodes.invalidRequest, msg: '文件名无效' }
  return { code: ErrorCodes.success, msg: '已转换路径', data: name }
}

/** 浏览器夹具：把路径导入当前目录快照。不写本机工程文件。 */
export function fixtureImportProjectFiles(
  request: ImportProjectFilesDTO
): AjaxResult<ImportProjectFilesVO> {
  if (readWorkbenchFixtureMode() === 'fail') {
    return { code: ErrorCodes.communicationFailed, msg: '当前环境不能操作工程文件' }
  }
  if (request.localFilePaths.length === 0) {
    return { code: ErrorCodes.invalidRequest, msg: '没有可导入的文件' }
  }
  const catalog = catalogOf(request.projectId)
  if (request.expectedCatalogVersion !== catalog.catalogVersion) {
    return { code: ErrorCodes.operationConflict, msg: '目录已变化，请刷新后再导入' }
  }
  if (
    request.parentFolderId !== null &&
    !catalog.folders.some((folder) => folder.folderId === request.parentFolderId)
  ) {
    return { code: ErrorCodes.invalidRequest, msg: '目标文件夹不存在' }
  }
  const importedFiles: ProjectInputSourceSummaryVO[] = []
  const failedFiles: { fileName: string; message: string }[] = []
  const occupied = catalog.sources
    .filter((source) => source.parentFolderId === request.parentFolderId)
    .map((source) => source.name)
  for (const path of request.localFilePaths) {
    const originalName = fileNameOf(path)
    const kind = fixtureSourceKind(originalName)
    if (!kind) {
      failedFiles.push({ fileName: originalName, message: '不支持的文件类型' })
      continue
    }
    const name = unusedImportName(originalName, occupied)
    if (!name) {
      failedFiles.push({ fileName: originalName, message: '没有可用的导入文件名' })
      continue
    }
    occupied.push(name)
    const sourceId = `import-${++importedSourceCount}`
    const summary = fixtureImportedSummary(sourceId, name, request.parentFolderId, kind)
    catalog.sources.push(summary)
    workbenchSourceDetails[sourceId] = fixtureImportedDetail(summary)
    importedFiles.push(summary)
  }
  if (importedFiles.length > 0) {
    catalog.catalogVersion = `fixture-${importedSourceCount}`
  }
  return {
    code: ErrorCodes.success,
    msg: '导入完成',
    data: { importedFiles, failedFiles }
  }
}

function fileNameOf(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] ?? path
}

function unusedImportName(
  originalFileName: string,
  occupiedNames: readonly string[]
): string | null {
  const occupied = occupiedNames.map((name) => name.toLowerCase())
  if (!occupied.includes(originalFileName.toLowerCase())) return originalFileName
  const dot = originalFileName.lastIndexOf('.')
  const stem = dot > 0 ? originalFileName.slice(0, dot) : originalFileName
  const ext = dot > 0 ? originalFileName.slice(dot) : ''
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = `${stem} (${index})${ext}`
    if (!occupied.includes(candidate.toLowerCase())) return candidate
  }
  return null
}

function fixtureSourceKind(fileName: string): ImportedKind | null {
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    return { contentKind: 'text', textKind: 'document' }
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif') {
    return { contentKind: 'image' }
  }
  if (ext === 'wav' || ext === 'mp3' || ext === 'ogg' || ext === 'flac') {
    return { contentKind: 'audio' }
  }
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov') return { contentKind: 'video' }
  return null
}

function fixtureImportedSummary(
  sourceId: string,
  name: string,
  parentFolderId: string | null,
  kind: ImportedKind
): ProjectInputSourceSummaryVO {
  if (kind.contentKind === 'text') {
    return {
      sourceId,
      name,
      readable: true,
      parentFolderId,
      contentKind: 'text',
      textKind: kind.textKind
    }
  }
  return {
    sourceId,
    name,
    readable: true,
    parentFolderId,
    contentKind: kind.contentKind
  }
}

function fixtureImportedDetail(source: ProjectInputSourceSummaryVO): ProjectInputSourceVO {
  if (source.contentKind === 'text') {
    const format = source.name.toLowerCase().endsWith('.txt') ? 'plainText' : 'markdown'
    return {
      sourceId: source.sourceId,
      version: 'v1',
      contentKind: 'text',
      textKind: 'document',
      title: source.name.replace(/\.[^.]+$/, ''),
      body: '',
      topics: [],
      importInfo: { format }
    }
  }
  return {
    sourceId: source.sourceId,
    version: 'v1',
    contentKind: source.contentKind,
    name: source.name.replace(/\.[^.]+$/, ''),
    fileId: `file-${source.sourceId}`,
    description: ''
  }
}
