import { isAbsolute, relative, sep } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import { decodeStorageKey } from '@infrastructure/project-files/public/projectFileStorage'

const assetDirectoryByType = ['background', 'bgm', 'figure', 'scene', '', 'vocal', 'video'] as const

export const WEBGAL_ASSET_DIRECTORIES = [
  'background',
  'bgm',
  'figure',
  'scene',
  'vocal',
  'video'
] as const

export function isInsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function runtimeAssetReference(assetType: number, rawReference: string): string {
  if (rawReference.includes('http://') || rawReference.includes('https://')) return rawReference
  const directory = assetDirectoryByType[assetType]
  if (!directory) return ''
  return `./game/${directory}/${rawReference.replaceAll('\\', '/')}`
}

export function projectAssetRelativePaths(kind: string, rawReference: string): readonly string[] {
  const normalized = rawReference.replaceAll('\\', '/').replace(/^\.\//u, '')
  const paths = [`game/${kind}/${normalized}`, `assets/${kind}/${normalized}`]
  if (!(SCENE_ASSET_RUNTIME_DIRECTORIES as readonly string[]).includes(kind)) return paths
  try {
    const resolved = resolveSceneAssetReference({
      sourcePath: normalized,
      runtimeDirectory: kind
    })
    if (
      !normalized.startsWith('game/') &&
      !normalized.startsWith('assets/') &&
      !paths.includes(resolved.canonicalPath)
    )
      paths.unshift(resolved.canonicalPath)
    const imported = /^([^/]+)\/(.+)$/u.exec(normalized)
    if (imported && decodeStorageKey(imported[1] ?? '') !== null) {
      const sourcePath = `assets/${normalized}`
      if (!paths.includes(sourcePath)) paths.push(sourcePath)
    }
  } catch (error) {
    if (!(error instanceof AppException) || error.message !== '素材用途无法解析') throw error
  }
  return paths
}

export function projectPathsForGameRequest(gameRelativePath: string): readonly string[] {
  const slash = gameRelativePath.indexOf('/')
  if (slash <= 0) return [`game/${gameRelativePath}`]
  const kind = gameRelativePath.slice(0, slash)
  if (!(WEBGAL_ASSET_DIRECTORIES as readonly string[]).includes(kind)) {
    return [`game/${gameRelativePath}`]
  }
  return projectAssetRelativePaths(kind, gameRelativePath.slice(slash + 1))
}

export const SCENE_ASSET_RUNTIME_DIRECTORIES = [
  'background',
  'figure',
  'bgm',
  'vocal',
  'video'
] as const

export type SceneAssetRuntimeDirectory = (typeof SCENE_ASSET_RUNTIME_DIRECTORIES)[number]

export type SceneAssetReferenceResolution = {
  readonly commandReference: string
  readonly sourcePath: string
  readonly canonicalPath: string
}

const kindDirectoryReference = /^(?:game|assets)\/(?:background|figure|bgm|vocal|video)\/(.+)$/u
const importedReference = /^assets\/([^/]+)\/(.+)$/u

export function neutralSceneAssetReference(sourcePath: string): string {
  const normalized = sourcePath.replaceAll('\\', '/').replace(/^\.\//u, '')
  const kindRelative = kindDirectoryReference.exec(normalized)
  if (kindRelative?.[1] !== undefined) return kindRelative[1]
  const imported = importedReference.exec(normalized)
  if (imported?.[1] !== undefined && imported[2] !== undefined)
    return `${imported[1]}/${imported[2]}`
  if (normalized.startsWith('game/') || normalized.startsWith('assets/')) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材用途无法解析' })
  }
  return normalized
}

export function resolveSceneAssetReference(input: {
  sourcePath: string
  runtimeDirectory: string
}): SceneAssetReferenceResolution {
  if (!(SCENE_ASSET_RUNTIME_DIRECTORIES as readonly string[]).includes(input.runtimeDirectory)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材用途无法解析' })
  }
  const runtimeDirectory = input.runtimeDirectory as SceneAssetRuntimeDirectory
  const sourcePath = input.sourcePath.replaceAll('\\', '/').replace(/^\.\//u, '')
  const kindPrefix = new RegExp(`^(?:game|assets)/${runtimeDirectory}/`, 'u')
  const imported = /^assets\/([^/]+)\/(.+)$/u.exec(sourcePath)
  const commandReference = kindPrefix.test(sourcePath)
    ? sourcePath.replace(kindPrefix, '')
    : imported && decodeStorageKey(imported[1] ?? '') !== null
      ? `${imported[1]}/${imported[2]}`
      : sourcePath.startsWith('game/') || sourcePath.startsWith('assets/')
        ? undefined
        : sourcePath
  if (commandReference === undefined) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '素材用途无法解析' })
  }
  return {
    commandReference,
    sourcePath,
    canonicalPath: `game/${runtimeDirectory}/${commandReference}`
  }
}
