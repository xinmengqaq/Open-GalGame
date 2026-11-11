import { createHash } from 'node:crypto'

import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { assertRelativePath } from '@infrastructure/git/containedPath'

export const PROJECT_INPUT_FORMAT_VERSION = 1
export const PROJECT_ARRANGEMENT_FORMAT_VERSION = 3
/** 带 `.json` 后缀后不超过常见 255 字符文件名组件。完整路径另受工程根与操作系统限制。 */
export const MAX_IDENTITY_BYTES = 125
export const MAX_TEXT_CHARS = 200_000
export const MAX_JSON_BYTES = 2_000_000
/** 一次预览最多读入 64 MiB。超过上限直接失败，不截断。 */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024

const SOURCE_DIRECTORY = '.opengalgame/inputs/sources'
export const PROJECT_CATALOG_FORMAT_VERSION = 1
export const PROJECT_CATALOG_PATH = '.opengalgame/inputs/catalog.json'
const DOCUMENT_DIRECTORY = '.opengalgame/inputs/documents'
const CANVAS_DIRECTORY = '.opengalgame/canvases'
const MANIFEST_PATH = '.opengalgame/manifest.json'

/**
 * @returns 可逆且不含路径分隔符的文件名主体。
 * @throws {AppException} 身份为空或超过持久化长度。
 */
export function encodeStorageKey(identity: string): string {
  const bytes = Buffer.from(identity, 'utf8')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IDENTITY_BYTES) {
    throw new AppException({
      code: ProjectFileErrorCodes.readFailed,
      msg: '工程文件无法读取'
    })
  }
  return bytes.toString('hex')
}

/**
 * @returns 业务身份；不是规范小写十六进制时为 null。
 */
export function decodeStorageKey(key: string): string | null {
  if (!/^[0-9a-f]{2,250}$/u.test(key) || key.length % 2 !== 0) return null
  try {
    const identity = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(key, 'hex'))
    if (Buffer.byteLength(identity) > MAX_IDENTITY_BYTES) return null
    if (encodeStorageKey(identity) !== key) return null
    return identity
  } catch {
    return null
  }
}

export function sourceDescriptorPath(sourceId: string): string {
  return `${SOURCE_DIRECTORY}/${encodeStorageKey(sourceId)}.json`
}

export function documentBodyPath(sourceId: string, extension: 'md' | 'txt'): string {
  return `${DOCUMENT_DIRECTORY}/${encodeStorageKey(sourceId)}.${extension}`
}

export function arrangementPath(sceneId: string, canvasId: string): string {
  return `${CANVAS_DIRECTORY}/${encodeStorageKey(sceneId)}/${encodeStorageKey(canvasId)}.json`
}

export const projectFileLocations = {
  manifest: MANIFEST_PATH,
  sources: SOURCE_DIRECTORY,
  canvases: CANVAS_DIRECTORY
}

/**
 * @returns 业务身份；不符合小写十六进制约定时为 null。
 */
export function identityFromDescriptorName(name: string): string | null {
  if (!name.endsWith('.json')) return null
  return decodeStorageKey(name.slice(0, -'.json'.length))
}

/**
 * @throws {AppException} 路径越界或不是素材位置。
 */
export function assertAssetMediaPath(mediaPath: string): string {
  const relative = assertRelativePath(mediaPath)
  if (!relative.startsWith('assets/') || relative.split('/').length < 2) {
    throw new AppException({
      code: ProjectFileErrorCodes.pathEscapesProject,
      msg: '来源位置超出工程范围'
    })
  }
  return relative
}

/** 用固定字段数组的 JSON 编码计算 SHA-256。 */
export function digestVersionParts(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
