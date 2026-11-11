import { createHash } from 'node:crypto'
import { createReadStream, type BigIntStats } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { assertRelativePath, resolveContained } from '@infrastructure/git/containedPath'
import { join } from 'node:path'

export type ObservedProjectFile = {
  relativePath: string
  absolutePath: string
  stats?: BigIntStats
}

export type DirectoryMember = {
  name: string
  stats: BigIntStats
}

export type DirectorySnapshot = {
  relativePath: string
  absolutePath: string
  members: readonly DirectoryMember[]
}

/** 共享文件读取的技术失败。调用方按自己的错误码转换。 */
export class StableFileReadError extends Error {
  readonly absolutePath?: string

  /**
   * @param kind - 缺失、不是文件、读取变化、无法读取或文本编码非法。
   * @param message - 技术说明，不直接给用户。
   * @param cause - 原始失败。
   */
  constructor(
    readonly kind: 'missing' | 'not-file' | 'changed' | 'unreadable' | 'invalid-text' | 'too-large',
    readonly relativePath: string,
    message: string,
    cause?: unknown,
    absolutePath?: string
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StableFileReadError'
    this.absolutePath = absolutePath
  }
}

/**
 * @returns 路径和文件状态；调用方决定缺失是否可接受。
 * @throws {StableFileReadError} 目标不是普通文件或无法读取。
 * @throws {AppException} 路径越界。
 */
export async function observeProjectFile(
  root: string,
  relativePath: string
): Promise<ObservedProjectFile> {
  const absolutePath = await resolveContained(root, relativePath)
  try {
    const stats = await stat(absolutePath, { bigint: true })
    if (!stats.isFile()) {
      throw new StableFileReadError(
        'not-file',
        relativePath,
        '路径不是普通文件',
        undefined,
        absolutePath
      )
    }
    return { relativePath, absolutePath, stats }
  } catch (error) {
    if (error instanceof StableFileReadError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StableFileReadError('missing', relativePath, '文件不存在', error, absolutePath)
    }
    throw new StableFileReadError('unreadable', relativePath, '文件无法读取', error, absolutePath)
  }
}

/**
 * 确认路径每一段都是普通文件或目录，不跟随符号链接和目录联接。
 * @throws {StableFileReadError} 路径含链接或目标不是普通文件。
 * @throws {AppException} 路径越界。
 */
export async function assertOrdinaryProjectFile(root: string, relativePath: string): Promise<void> {
  const safe = assertRelativePath(relativePath)
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.forbidden,
      msg: '路径超出允许范围',
      cause: error
    })
  }
  let current = rootReal
  for (const part of safe.split('/')) {
    current = join(current, part)
    let linkStats: Awaited<ReturnType<typeof lstat>>
    try {
      linkStats = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StableFileReadError('missing', relativePath, '文件不存在', error, current)
      }
      throw new StableFileReadError('unreadable', relativePath, '文件无法读取', error, current)
    }
    if (linkStats.isSymbolicLink()) {
      throw new StableFileReadError(
        'unreadable',
        relativePath,
        '路径不能是链接',
        undefined,
        current
      )
    }
  }
  const finalStats = await lstat(current)
  if (!finalStats.isFile() || finalStats.isSymbolicLink()) {
    throw new StableFileReadError('not-file', relativePath, '路径不是普通文件', undefined, current)
  }
}

/** 比较文件身份和精确时间，识别替换、写入和删除。 */
export function sameFileStats(
  first: BigIntStats | undefined,
  second: BigIntStats | undefined
): boolean {
  if (!first || !second) return first === second
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  )
}

/**
 * 严格解码 UTF-8，保留 BOM 和原始换行。
 * @throws {TypeError} 字节不是合法 UTF-8。
 */
export function decodeStrictUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/**
 * 流式计算文件摘要，结束或失败时关闭流。
 * @throws {StableFileReadError} 流读取失败。
 */
export async function digestProjectFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(absolutePath)
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } catch (error) {
    throw new StableFileReadError('unreadable', absolutePath, '文件无法读取', error, absolutePath)
  } finally {
    stream.destroy()
  }
}

/**
 * 读取文件开头，不把整个媒体载入内存。
 * @throws {StableFileReadError} 文件无法打开或读取。句柄会关闭。
 */
export async function readProjectFilePrefix(absolutePath: string, length: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(absolutePath, 'r')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } catch (error) {
    throw new StableFileReadError('unreadable', absolutePath, '文件无法读取', error, absolutePath)
  } finally {
    await handle?.close()
  }
}

/**
 * @returns 按名称排序的成员；目录不存在时为 null。
 * @throws {StableFileReadError} 目标不是目录或无法枚举。
 * @throws {AppException} 路径越界。
 */
export async function captureProjectDirectory(
  root: string,
  relativePath: string
): Promise<DirectorySnapshot | null> {
  const absolutePath = await resolveContained(root, relativePath)
  try {
    const stats = await lstat(absolutePath)
    if (stats.isSymbolicLink()) {
      throw new StableFileReadError(
        'unreadable',
        relativePath,
        '目录不能是链接',
        undefined,
        absolutePath
      )
    }
    if (!stats.isDirectory()) {
      throw new StableFileReadError(
        'unreadable',
        relativePath,
        '路径不是目录',
        undefined,
        absolutePath
      )
    }
    const names = (await readdir(absolutePath)).sort((left, right) => compareText(left, right))
    const members: DirectoryMember[] = []
    for (const name of names) {
      members.push(await observeDirectoryMember(root, relativePath, name))
    }
    return { relativePath, absolutePath, members }
  } catch (error) {
    if (error instanceof StableFileReadError || error instanceof AppException) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StableFileReadError('unreadable', relativePath, '目录无法枚举', error, absolutePath)
  }
}

async function observeDirectoryMember(
  root: string,
  directory: string,
  name: string
): Promise<DirectoryMember> {
  const relativePath = `${directory}/${name}`
  try {
    const absolutePath = await resolveContained(root, relativePath)
    return { name, stats: await lstat(absolutePath, { bigint: true }) }
  } catch (error) {
    if (error instanceof AppException || error instanceof StableFileReadError) throw error
    throw new StableFileReadError('unreadable', relativePath, '目录无法枚举', error)
  }
}

/** 按 UTF-16 码元比较，不使用本机语言环境。 */
export function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * @throws {StableFileReadError} 文件缺失、变化或无法读取。
 */
export async function readStableProjectFile(
  root: string,
  relativePath: string,
  maxBytes?: number
): Promise<{ observation: ObservedProjectFile; bytes: Buffer }> {
  const observation = await observeProjectFile(root, relativePath)
  if (
    maxBytes !== undefined &&
    observation.stats !== undefined &&
    observation.stats.size > BigInt(maxBytes)
  ) {
    throw new StableFileReadError(
      'too-large',
      relativePath,
      '文件超出允许大小',
      undefined,
      observation.absolutePath
    )
  }
  let bytes: Buffer
  try {
    bytes = await readFile(observation.absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StableFileReadError(
        'changed',
        relativePath,
        '文件在读取期间变化',
        error,
        observation.absolutePath
      )
    }
    throw new StableFileReadError(
      'unreadable',
      relativePath,
      '文件无法读取',
      error,
      observation.absolutePath
    )
  }
  await assertSameObservation(root, observation)
  return { observation, bytes }
}

/**
 * 确认文件仍是观察时的那个版本。
 * @param observation - 读取开始时的状态。缺失文件的观察没有 stats。
 * @throws {StableFileReadError} 路径或状态发生变化。
 */
export async function assertSameObservation(
  root: string,
  observation: ObservedProjectFile
): Promise<void> {
  try {
    const current = await observeProjectFile(root, observation.relativePath)
    if (
      current.absolutePath !== observation.absolutePath ||
      !sameFileStats(current.stats, observation.stats)
    ) {
      throw new StableFileReadError(
        'changed',
        observation.relativePath,
        '文件在读取期间变化',
        undefined,
        observation.absolutePath
      )
    }
  } catch (error) {
    if (error instanceof StableFileReadError && error.kind === 'changed') throw error
    if (
      error instanceof StableFileReadError &&
      error.kind === 'missing' &&
      observation.stats === undefined
    )
      return
    if (
      error instanceof StableFileReadError &&
      (error.kind === 'missing' || error.kind === 'not-file')
    ) {
      throw new StableFileReadError(
        'changed',
        observation.relativePath,
        '文件在读取期间变化',
        error,
        observation.absolutePath
      )
    }
    throw error
  }
}
