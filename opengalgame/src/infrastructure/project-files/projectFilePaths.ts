import { createHash } from 'node:crypto'

import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { assertRelativePath } from '@infrastructure/git/containedPath'

export const PROJECT_INPUT_FORMAT_VERSION = 1
export const MAX_IDENTITY_BYTES = 125
export const MAX_TEXT_CHARS = 200_000
export const MAX_JSON_BYTES = 2_000_000
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024

const SOURCE_DIRECTORY = '.opengalgame/inputs/sources'
export const PROJECT_CATALOG_FORMAT_VERSION = 1
export const PROJECT_CATALOG_PATH = '.opengalgame/inputs/catalog.json'
const DOCUMENT_DIRECTORY = '.opengalgame/inputs/documents'
const MANIFEST_PATH = '.opengalgame/manifest.json'

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

export const projectFileLocations = {
  manifest: MANIFEST_PATH,
  sources: SOURCE_DIRECTORY
}

export function identityFromDescriptorName(name: string): string | null {
  if (!name.endsWith('.json')) return null
  return decodeStorageKey(name.slice(0, -'.json'.length))
}

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

export function digestVersionParts(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
