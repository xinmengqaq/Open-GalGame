import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AppException } from '@common/errors/AppException'

const TEMPORARY_NAME_PREFIX = '.opengalgame-tmp-'

export interface StorageFailure {
  code: number
  msg: string
  diskFull?: { code: number; msg: string }
  notWritable?: { code: number; msg: string }
}

/** 判断文件名是否是本能力写坏的临时文件。列举目录时据此跳过残留。 */
export function isTemporaryDocumentName(name: string): boolean {
  return name.startsWith(TEMPORARY_NAME_PREFIX)
}

/**
 * @param failure - 内容不是合法 JSON 时的错误码与中文说明。
 * @throws {AppException} 内容无法解析。
 */
export function parseJsonDocumentContent(content: string, failure: StorageFailure): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new AppException({ ...failure, cause: error })
  }
}

/**
 * @param failure - 内容不是合法 JSON 时的错误码与中文说明。
 * @returns 解析结果；文件不存在时为 null。
 * @throws {AppException} 读取失败或内容无法解析。
 */
export async function readJsonDocument(
  path: string,
  failure: StorageFailure
): Promise<unknown | null> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw mapStorageFailure(error, failure)
  }
  return parseJsonDocumentContent(content, failure)
}

/**
 * 原子替换 JSON 文档：先写同目录临时文件并落盘，再改名覆盖，中断不会留下半个文件。
 * @param failure - 写入失败时的错误码与中文说明。
 * @param options - compact 为真时不缩进。缺省仍写双空格缩进，避免改变其他调用方。
 * @throws {AppException} 写入或改名失败。
 */
export async function writeJsonDocument(
  path: string,
  value: unknown,
  failure: StorageFailure,
  options?: { compact?: boolean }
): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `${TEMPORARY_NAME_PREFIX}${randomUUID()}`)
  const json = options?.compact ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, json, { flag: 'wx', flush: true })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw mapStorageFailure(error, failure)
  }
}

/**
 * 删除文档，文件不存在时不做事。
 * @param failure - 删除失败时的错误码与中文说明。
 * @throws {AppException} 删除失败。
 */
export async function deleteJsonDocument(path: string, failure: StorageFailure): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
}

/**
 * 列出目录中的文件名，目录不存在时为空。
 * @param failure - 读取失败时的错误码与中文说明。
 * @throws {AppException} 目录无法读取。
 */
export async function listDocumentNames(
  directory: string,
  failure: StorageFailure
): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw mapStorageFailure(error, failure)
  }
}

/**
 * 把文件系统技术错误转换为安全失败。磁盘满与无权限用调用方给出的码，没给就沿用 fallback 的码。
 * @param error - 原始失败。
 * @param fallback - 失败码；可带磁盘满与无权限的单独码。
 */
export function mapStorageFailure(error: unknown, fallback: StorageFailure): AppException {
  if (error instanceof AppException) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOSPC')
    return new AppException({
      code: fallback.diskFull?.code ?? fallback.code,
      msg: fallback.diskFull?.msg ?? '磁盘空间不足',
      cause: error
    })
  if (code === 'EACCES' || code === 'EPERM')
    return new AppException({
      code: fallback.notWritable?.code ?? fallback.code,
      msg: fallback.notWritable?.msg ?? '保存位置不可访问或不可写',
      cause: error
    })
  return new AppException({ code: fallback.code, msg: fallback.msg, cause: error })
}
