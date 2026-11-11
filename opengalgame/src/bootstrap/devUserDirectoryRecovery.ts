import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'

import {
  readProjectRegistrations,
  writeProjectRegistrations
} from '@infrastructure/projects/projectRegistrations'
import { readJsonDocument, writeJsonDocument } from '@infrastructure/storage/jsonDocument'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export interface DevUserDirectoryRecoveryResult {
  readonly recovered: number
  readonly skippedConflicts: number
  readonly sources: number
}

const recoveryFailure = {
  code: ErrorCodes.invalidConfig,
  msg: '用户目录恢复失败，请检查开发用户目录配置'
}
const markerSchema = z.strictObject({ version: z.literal(1), sources: z.array(z.string()) })

/**
 * 把仅尾随空白不同的旧开发目录并入规范目录。规范目录已有内容优先，已处理来源记入 marker。
 * @throws {AppException} 旧目录可读但恢复无法完成。
 */
export async function recoverLegacyUserDirectory(
  canonicalDirectory: string
): Promise<DevUserDirectoryRecoveryResult> {
  try {
    return await recover(canonicalDirectory)
  } catch (error) {
    if (error instanceof AppException && error.code === ErrorCodes.invalidConfig) throw error
    throw new AppException({ ...recoveryFailure, cause: error })
  }
}

async function recover(canonicalDirectory: string): Promise<DevUserDirectoryRecoveryResult> {
  const canonicalName = basename(canonicalDirectory)
  const registrations = await readProjectRegistrations(canonicalDirectory)
  const marker = await readMarker(join(canonicalDirectory, 'dev-recovery.json'))
  const candidates = (await listLegacyDirectories(dirname(canonicalDirectory), canonicalName))
    .filter((name) => !marker.includes(name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  if (candidates.length === 0) {
    return { recovered: 0, skippedConflicts: 0, sources: 0 }
  }

  const seenIds = new Set(registrations.map((item) => item.id))
  const seenDirectories = new Set(registrations.map((item) => directoryKey(item.directory)))
  const seenOperations = new Set(registrations.map((item) => item.operationId))
  const merged = [...registrations]
  let skippedConflicts = 0
  const readable: string[] = []
  for (const name of candidates) {
    const source = join(dirname(canonicalDirectory), name)
    if (!(await isFile(join(source, 'projects.json')))) continue
    readable.push(name)
    const incoming = await readProjectRegistrations(source)
    for (const item of incoming) {
      if (
        seenIds.has(item.id) ||
        seenDirectories.has(directoryKey(item.directory)) ||
        seenOperations.has(item.operationId)
      ) {
        skippedConflicts += 1
        continue
      }
      seenIds.add(item.id)
      seenDirectories.add(directoryKey(item.directory))
      seenOperations.add(item.operationId)
      merged.push(item)
    }
  }
  if (readable.length === 0) {
    return { recovered: 0, skippedConflicts: 0, sources: 0 }
  }

  const recovered = merged.length - registrations.length
  if (recovered > 0) await writeProjectRegistrations(canonicalDirectory, merged)
  for (const name of readable) {
    const source = join(dirname(canonicalDirectory), name)
    await copyOperations(source, canonicalDirectory)
    await copyIfMissing(
      join(source, 'browser-models.json'),
      join(canonicalDirectory, 'browser-models.json')
    )
    await copyCredentialPair(source, canonicalDirectory)
  }
  await writeJsonDocument(
    join(canonicalDirectory, 'dev-recovery.json'),
    { version: 1, sources: [...marker, ...readable] },
    recoveryFailure
  )
  return { recovered, skippedConflicts, sources: readable.length }
}

async function readMarker(path: string): Promise<string[]> {
  const value = await readJsonDocument(path, recoveryFailure)
  if (value === null) return []
  const parsed = markerSchema.safeParse(value)
  if (!parsed.success) throw new AppException(recoveryFailure)
  return parsed.data.sources
}

async function listLegacyDirectories(parent: string, canonicalName: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) => name.startsWith(canonicalName) && /^[ \t]+$/.test(name.slice(canonicalName.length))
    )
}

async function copyOperations(source: string, canonicalDirectory: string): Promise<void> {
  const sourceDirectory = join(source, 'operations')
  let names: string[]
  try {
    names = await readdir(sourceDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const targetDirectory = join(canonicalDirectory, 'operations')
  for (const name of names) {
    if (!name.endsWith('.json') || !OPERATION_ID_PATTERN.test(name.slice(0, -'.json'.length)))
      continue
    await mkdir(targetDirectory, { recursive: true })
    await copyFile(
      join(sourceDirectory, name),
      join(targetDirectory, name),
      constants.COPYFILE_EXCL
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}

async function copyCredentialPair(source: string, canonicalDirectory: string): Promise<void> {
  const credentials = 'browser-credentials.json'
  const key = 'browser-dev-key'
  const canonicalCredentials = await isFile(join(canonicalDirectory, credentials))
  const canonicalKey = await isFile(join(canonicalDirectory, key))
  if (canonicalCredentials || canonicalKey) return
  const sourceCredentials = join(source, credentials)
  const sourceKey = join(source, key)
  if (!(await isFile(sourceCredentials)) || !(await isFile(sourceKey))) return
  if ((await stat(sourceKey)).size !== 32) return
  await copyIfMissing(sourceCredentials, join(canonicalDirectory, credentials))
  await copyIfMissing(sourceKey, join(canonicalDirectory, key))
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  if (!(await isFile(source)) || (await isFile(target))) return
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function directoryKey(directory: string): string {
  const resolved = resolve(directory)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
