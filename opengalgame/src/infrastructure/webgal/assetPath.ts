import { isAbsolute, relative, sep } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import { decodeStorageKey } from '@infrastructure/project-files/projectFilePaths'

/** 与 `webgal-engine@4.6.5` 的 fileType 顺序一致。tex 没有 game 目录。 */
const assetDirectoryByType = ['background', 'bgm', 'figure', 'scene', '', 'vocal', 'video'] as const

export const WEBGAL_ASSET_DIRECTORIES = [
  'background',
  'bgm',
  'figure',
  'scene',
  'vocal',
  'video'
] as const

/**
 * 判断候选路径是否仍在指定根目录内。
 * @param root - 已解析的根目录。
 * @returns 候选路径位于根目录内时为 true。
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function assetKind(assetType: number): string {
  return assetDirectoryByType[assetType] || `type-${assetType}`
}

/**
 * @returns `./game/<目录>/<原文>`；远程地址原样返回，tex 返回空字符串。
 */
export function runtimeAssetReference(assetType: number, rawReference: string): string {
  if (rawReference.includes('http://') || rawReference.includes('https://')) return rawReference
  const directory = assetDirectoryByType[assetType]
  if (!directory) return ''
  return `./game/${directory}/${rawReference.replaceAll('\\', '/')}`
}

/**
 * 把一种素材引用映射到工程内的只读位置。
 * 种类目录仍是 `game/<种类>/<原文>` 和 `assets/<种类>/<原文>`。
 * 编排登记的来源存储键再查 `assets/<原文>`，不扫整个 assets。
 * @param rawReference - 脚本原始引用，不剥前缀。
 */
export function projectAssetRelativePaths(kind: string, rawReference: string): readonly string[] {
  const normalized = rawReference.replaceAll('\\', '/').replace(/^\.\//u, '')
  const paths = [`game/${kind}/${normalized}`, `assets/${kind}/${normalized}`]
  if (!(SCENE_ASSET_RUNTIME_DIRECTORIES as readonly string[]).includes(kind)) return paths
  try {
    const resolved = resolveSceneAssetReference({
      sourcePath: normalized,
      runtimeDirectory: kind
    })
    if (!paths.includes(resolved.canonicalPath)) paths.unshift(resolved.canonicalPath)
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

/**
 * @returns 与素材引用相同的候选列表；非素材目录只查 `game/`。
 */
export function projectPathsForGameRequest(gameRelativePath: string): readonly string[] {
  const slash = gameRelativePath.indexOf('/')
  if (slash <= 0) return [`game/${gameRelativePath}`]
  const kind = gameRelativePath.slice(0, slash)
  if (!(WEBGAL_ASSET_DIRECTORIES as readonly string[]).includes(kind)) {
    return [`game/${gameRelativePath}`]
  }
  return projectAssetRelativePaths(kind, gameRelativePath.slice(slash + 1))
}

/** WebGAL 运行时目录。用途不明时不能从文件名或扩展名猜测。 */
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

/**
 * 由编排登记路径给出与命令无关的稳定素材引用。
 * 已在种类目录下的路径去掉该目录；来源存储键保留在引用里。
 * @throws {AppException} 落在素材根目录内但无法解析用途的路径。
 */
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

/**
 * 由明确用途解析命令引用、源路径和规范路径。
 * 已在 `game/` 下的素材保持原路径；来源存储键保留在引用里。
 * @throws {AppException} 用途不明或路径不能安全映射。
 */
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
