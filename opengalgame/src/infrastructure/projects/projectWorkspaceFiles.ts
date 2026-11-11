import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { projectDocumentFailure } from './projectDocumentFailure'
import { readJsonDocument, writeJsonDocument } from '../storage/jsonDocument'
import { assertRelativePath, resolveContained } from '@infrastructure/git/containedPath'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const workspaceFailure = projectDocumentFailure(
  ProjectErrorCodes.storageFailed,
  '工程工作区读写失败'
)

/**
 * 逐段创建真实目录，拒绝符号链接，并确认结果仍在工程根内。
 * @throws {AppException} 路径越界、被链接占用或目录不能创建。
 */
export async function ensureRealDirectory(root: string, relativeDirectory: string): Promise<void> {
  const safe = assertRelativePath(relativeDirectory)
  let current = root
  for (const part of safe.split('/')) {
    current = join(current, part)
    const stats = await optionalStat(current)
    if (!stats) {
      try {
        await mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new AppException({
            code: ProjectErrorCodes.storageFailed,
            msg: '工程工作区读写失败',
            cause: error
          })
        }
      }
    }
    const created = await optionalStat(current)
    if (!created?.isDirectory() || created.isSymbolicLink()) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    const real = await realpath(current)
    if (!staysInside(root, real)) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    current = real
  }
}

/**
 * 文件缺失时写入空文件。已有真实文件保持原样。
 * @throws {AppException} 路径被链接或目录占用，或写入失败。
 */
export async function ensureEmptyFile(root: string, relativePath: string): Promise<void> {
  const absolute = await containedFile(root, relativePath)
  const stats = await optionalStat(absolute)
  if (stats) {
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '路径超出允许范围' })
    }
    return
  }
  try {
    await writeFile(absolute, '', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw new AppException({
      code: ProjectErrorCodes.storageFailed,
      msg: '工程工作区读写失败',
      cause: error
    })
  }
}

/**
 * 只确认工程内已有真实文件。缺失、目录或符号链接返回 false。不创建。
 * @throws {AppException} 路径越界或工程根无法确认。
 */
export async function isRealWorkspaceFile(root: string, relativePath: string): Promise<boolean> {
  const absolute = await containedFile(root, relativePath)
  const stats = await optionalStat(absolute)
  return stats !== null && stats.isFile() && !stats.isSymbolicLink()
}

/**
 * @returns 解析后的文档；文件不存在时为 null。
 * @throws {AppException} 路径不安全或内容无法解析。
 */
export async function readWorkspaceDocument(
  root: string,
  relativePath: string
): Promise<unknown | null> {
  return readJsonDocument(await containedFile(root, relativePath), workspaceFailure)
}

/**
 * 原子替换工程内 JSON。调用方负责只在内容确实变化时调用。
 * @throws {AppException} 路径不安全或写入失败。
 */
export async function writeWorkspaceDocument(
  root: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  await writeJsonDocument(await containedFile(root, relativePath), value, workspaceFailure)
}

async function containedFile(root: string, relativePath: string): Promise<string> {
  try {
    return await resolveContained(await realpath(root), relativePath)
  } catch (error) {
    if (error instanceof AppException) throw error
    throw new AppException({
      code: ProjectErrorCodes.storageFailed,
      msg: '工程工作区读写失败',
      cause: error
    })
  }
}

async function optionalStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new AppException({
      code: ProjectErrorCodes.storageFailed,
      msg: '工程工作区读写失败',
      cause: error
    })
  }
}

function staysInside(root: string, target: string): boolean {
  const fromRoot = relative(resolve(root), resolve(target)).replaceAll('\\', '/')
  return fromRoot === '' || (!fromRoot.startsWith('../') && fromRoot !== '..')
}
