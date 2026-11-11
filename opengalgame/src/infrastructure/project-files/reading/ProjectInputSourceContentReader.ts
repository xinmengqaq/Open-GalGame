import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import type { ProjectInputSource } from '@domain/project-files/models/ProjectInputSource'
import {
  identifyMediaFormat,
  mediaFormatMatchesFileType
} from '@infrastructure/media/identifyMediaFormat'
import { StableFileReadError } from '@infrastructure/storage/StableProjectFileReader'
import type { ProjectInputSourceDocument } from '../documents/ProjectInputSourceDocument'
import {
  assertAssetMediaPath,
  digestVersionParts,
  documentBodyPath,
  encodeStorageKey,
  MAX_TEXT_CHARS
} from '../projectFilePaths'
import { toProjectInputSource } from '../mapping/ProjectFileReadFactsMapper'
import type { SourceCatalogRecord } from './ProjectInputSourceCatalog'
import type { ProjectFileReadWindow } from './ProjectFileReadWindow'

export type SourceContentRead =
  { status: 'present'; source: ProjectInputSource } | { status: 'missing' } | { status: 'damaged' }

/**
 * @returns 来源事实，或缺失、损坏。
 * @throws {AppException} 路径越界或读取期间变化。
 */
export async function readSourceContent(
  window: ProjectFileReadWindow,
  record: Extract<SourceCatalogRecord, { status: 'parsed' }>
): Promise<SourceContentRead> {
  try {
    if (record.document.projectId !== window.projectId) return { status: 'damaged' }
    const content = await readContentPayload(window, record.document)
    if (content === null) return { status: 'missing' }
    return {
      status: 'present',
      source: toProjectInputSource(
        record.document,
        content.payload,
        sourceVersion(
          window.projectId,
          record.document.sourceId,
          record.descriptorDigest,
          content.digest
        )
      )
    }
  } catch (error) {
    if (error instanceof AppException && error.code === ProjectFileErrorCodes.pathEscapesProject)
      throw error
    if (error instanceof StableFileReadError && error.kind === 'changed') throw error
    if (error instanceof AppException && error.code === ProjectFileErrorCodes.readChanged)
      throw error
    if (error instanceof StableFileReadError && error.kind === 'missing')
      return { status: 'missing' }
    if (error instanceof AppException && error.code === ProjectFileErrorCodes.contentDamaged) {
      return { status: 'damaged' }
    }
    if (error instanceof StableFileReadError && error.kind === 'invalid-text')
      return { status: 'damaged' }
    throw error
  }
}

/** 轻量判断描述对应的内容是否可访问，不加载全部正文或媒体。 */
export async function probeSourceReadable(
  window: ProjectFileReadWindow,
  document: ProjectInputSourceDocument
): Promise<boolean> {
  if (document.projectId !== window.projectId) return false
  const content = document.content
  if (content.kind === 'document') {
    if (
      !bodyFileMatches(
        document.sourceId,
        content.bodyFile,
        content.importFormat === 'markdown' ? 'md' : 'txt'
      )
    ) {
      return false
    }
    return (
      (await window.observeExisting(
        documentBodyPath(document.sourceId, content.importFormat === 'markdown' ? 'md' : 'txt')
      )) !== null
    )
  }
  try {
    const mediaPath = assertAssetMediaPath(content.mediaPath)
    const media = await window.readPrefix(mediaPath)
    if (media === null) return false
    let identification = await identifyMediaFormat(media.prefix)
    if (!identification.supported && content.fileType === 'image') {
      const full = await window.readOptionalBytes(mediaPath)
      if (full) identification = await identifyMediaFormat(full.bytes)
    }
    return mediaFormatMatchesFileType(content.fileType, identification)
  } catch (error) {
    if (error instanceof AppException && error.code === ProjectFileErrorCodes.pathEscapesProject)
      throw error
    return false
  }
}

async function readContentPayload(
  window: ProjectFileReadWindow,
  document: ProjectInputSourceDocument
): Promise<{ payload: string; digest: string } | null> {
  const content = document.content
  if (content.kind === 'document') {
    const extension = content.importFormat === 'markdown' ? 'md' : 'txt'
    if (!bodyFileMatches(document.sourceId, content.bodyFile, extension)) {
      throw damaged()
    }
    const file = await window.readOptionalBytes(documentBodyPath(document.sourceId, extension))
    if (file === null) return null
    const text = decodeBody(file.bytes, documentBodyPath(document.sourceId, extension))
    return { payload: text, digest: file.digest }
  }
  const mediaPath = assertAssetMediaPath(content.mediaPath)
  const existing = await window.observeExisting(mediaPath)
  if (existing === null) return null
  const media = await window.readMedia(mediaPath)
  let identification = await identifyMediaFormat(media.prefix)
  if (!identification.supported && content.fileType === 'image') {
    const full = await window.readOptionalBytes(mediaPath)
    if (full) identification = await identifyMediaFormat(full.bytes)
  }
  if (!mediaFormatMatchesFileType(content.fileType, identification)) throw damaged()
  return { payload: '', digest: media.digest }
}

function decodeBody(bytes: Buffer, path: string): string {
  if (bytes.byteLength > MAX_TEXT_CHARS * 4) throw damaged()
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (text.length > MAX_TEXT_CHARS) throw damaged()
    return text
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new StableFileReadError('invalid-text', path, '不是合法 UTF-8', error)
  }
}

function bodyFileMatches(sourceId: string, bodyFile: string, extension: string): boolean {
  return bodyFile === `${encodeStorageKey(sourceId)}.${extension}`
}

function sourceVersion(
  projectId: string,
  sourceId: string,
  descriptorDigest: string,
  contentDigest: string
): string {
  return digestVersionParts([
    'project-file-source-v1',
    projectId,
    sourceId,
    descriptorDigest,
    contentDigest
  ])
}

function damaged(): AppException {
  return new AppException({
    code: ProjectFileErrorCodes.contentDamaged,
    msg: '工程文件内容损坏'
  })
}
