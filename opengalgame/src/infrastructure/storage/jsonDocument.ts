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

export function isTemporaryDocumentName(name: string): boolean {
  return name.startsWith(TEMPORARY_NAME_PREFIX)
}

export function parseJsonDocumentContent(content: string, failure: StorageFailure): unknown {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new AppException({ ...failure, cause: error })
  }
}

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

export async function deleteJsonDocument(path: string, failure: StorageFailure): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    throw mapStorageFailure(error, failure)
  }
}

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
