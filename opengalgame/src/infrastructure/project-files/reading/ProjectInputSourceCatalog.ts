import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import {
  isTemporaryDocumentName,
  parseJsonDocumentContent
} from '@infrastructure/storage/jsonDocument'
import { StableFileReadError } from '@infrastructure/storage/StableProjectFileReader'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'
import {
  projectInputSourceDocumentSchema,
  projectInputSourceFormatProbeSchema,
  type ProjectInputSourceDocument
} from '../documents/ProjectInputSourceDocument'
import {
  identityFromDescriptorName,
  PROJECT_INPUT_FORMAT_VERSION,
  projectFileLocations
} from '../projectFilePaths'
import type { ProjectFileReadWindow } from './ProjectFileReadWindow'

export type SourceCatalogRecord =
  | {
      status: 'parsed'
      filenameId: string
      claimedId: string
      relativePath: string
      document: ProjectInputSourceDocument
      descriptorDigest: string
    }
  | {
      status: 'unsupported'
      filenameId: string
      claimedId?: string
      relativePath: string
    }
  | {
      status: 'damaged'
      filenameId: string
      claimedId?: string
      relativePath: string
      document?: ProjectInputSourceDocument
    }

/**
 * 枚举来源描述并保留重复身份。
 * 临时文件按既有约定跳过；无法识别身份的名称使整次读取失败。
 * @returns 描述记录，不以 Map 覆盖重复身份。
 * @throws {AppException} 目录无法枚举，或存在无法识别的描述文件名。
 */
export async function loadSourceCatalog(
  window: ProjectFileReadWindow
): Promise<SourceCatalogRecord[]> {
  const directory = await window.captureDirectory(projectFileLocations.sources)
  if (directory === null) return []
  const records: SourceCatalogRecord[] = []
  for (const member of directory.members) {
    if (isTemporaryDocumentName(member.name)) continue
    if (!member.stats.isFile()) {
      throw new AppException({
        code: ProjectFileErrorCodes.readFailed,
        msg: '工程文件无法读取'
      })
    }
    const filenameId = identityFromDescriptorName(member.name)
    if (filenameId === null) {
      throw new AppException({
        code: ProjectFileErrorCodes.readFailed,
        msg: '工程文件无法读取'
      })
    }
    const relativePath = `${projectFileLocations.sources}/${member.name}`
    records.push(await readDescriptorRecord(window, filenameId, relativePath))
  }
  return records
}

async function readDescriptorRecord(
  window: ProjectFileReadWindow,
  filenameId: string,
  relativePath: string
): Promise<SourceCatalogRecord> {
  let text: string
  let descriptorDigest: string
  try {
    const file = await window.readText(relativePath)
    text = file.text
    descriptorDigest = file.digest
  } catch (error) {
    if (error instanceof StableFileReadError && error.kind === 'missing') {
      throw new StableFileReadError('changed', relativePath, '文件在读取期间变化', error)
    }
    if (error instanceof StableFileReadError && error.kind === 'invalid-text') {
      return { status: 'damaged', filenameId, relativePath }
    }
    throw error
  }
  let value: unknown
  try {
    value = parseJsonDocumentContent(text, {
      code: ProjectFileErrorCodes.contentDamaged,
      msg: '工程文件内容损坏'
    })
  } catch (error) {
    if (error instanceof AppException && error.code === ProjectFileErrorCodes.contentDamaged) {
      return { status: 'damaged', filenameId, relativePath }
    }
    throw error
  }
  const probe = projectInputSourceFormatProbeSchema.safeParse(value)
  const claimedId =
    probe.success && typeof probe.data.sourceId === 'string' && probe.data.sourceId.trim() !== ''
      ? probe.data.sourceId
      : undefined
  if (!probe.success || probe.data.formatVersion !== PROJECT_INPUT_FORMAT_VERSION) {
    if (probe.success && typeof probe.data.formatVersion === 'number') {
      return { status: 'unsupported', filenameId, claimedId, relativePath }
    }
    return { status: 'damaged', filenameId, claimedId, relativePath }
  }
  if (isRetiredSourceKind(value)) {
    return { status: 'unsupported', filenameId, claimedId, relativePath }
  }
  try {
    const document = parseUnknownValue(
      projectInputSourceDocumentSchema,
      value,
      ProjectFileErrorCodes.contentDamaged,
      '工程文件内容损坏'
    )
    if (document.sourceId !== filenameId) {
      return {
        status: 'damaged',
        filenameId,
        claimedId: document.sourceId,
        relativePath,
        document
      }
    }
    return {
      status: 'parsed',
      filenameId,
      claimedId: document.sourceId,
      relativePath,
      document,
      descriptorDigest
    }
  } catch (error) {
    if (error instanceof AppException && error.code === ProjectFileErrorCodes.contentDamaged) {
      return { status: 'damaged', filenameId, claimedId, relativePath }
    }
    throw error
  }
}

/**
 * 检查记录使用的来源身份。优先使用描述中的身份，便于发现重复。
 * @returns 用于诊断和重复判断的身份。
 */
export function catalogSourceId(record: SourceCatalogRecord): string {
  return record.claimedId ?? record.filenameId
}

function isRetiredSourceKind(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('content' in value)) return false
  const content = (value as { content?: unknown }).content
  if (!content || typeof content !== 'object' || !('kind' in content)) return false
  const kind = (content as { kind?: unknown }).kind
  return kind === 'animation' || kind === 'effect' || kind === 'prompt'
}
