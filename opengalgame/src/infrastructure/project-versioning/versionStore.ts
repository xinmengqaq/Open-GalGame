import { join } from 'node:path'
import type { z } from 'zod'

import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { resolveRepositoryMetadata } from '@infrastructure/git/containedPath'
import {
  isTemporaryDocumentName,
  listDocumentNames,
  readJsonDocument,
  writeJsonDocument,
  type StorageFailure
} from '@infrastructure/storage/jsonDocument'
import { parseUnknownValue } from '@infrastructure/validation/parseUnknownValue'

const diskFull = {
  code: ProjectVersioningErrorCodes.gitUnavailable,
  msg: '磁盘空间不足，版本记录未写入'
}
const notWritable = {
  code: ProjectVersioningErrorCodes.gitUnavailable,
  msg: '版本记录位置不可写'
}

export const versionReadFailure: StorageFailure = {
  code: ProjectVersioningErrorCodes.gitQueryFailed,
  msg: '版本记录无法读取',
  diskFull,
  notWritable
}

export const versionWriteFailure: StorageFailure = {
  code: ProjectVersioningErrorCodes.gitUnavailable,
  msg: '版本记录写入失败',
  diskFull,
  notWritable
}

/** 版本协议文档只放在本仓库 Git 元数据内。 */
export async function versionDocumentPath(
  projectRoot: string,
  segments: readonly string[],
  name: string
): Promise<string> {
  return join(await resolveRepositoryMetadata(projectRoot, segments), name)
}

export function readVersionValue(path: string): Promise<unknown | null> {
  return readJsonDocument(path, versionReadFailure)
}

export function writeVersionValue(path: string, value: unknown): Promise<void> {
  return writeJsonDocument(path, value, versionWriteFailure)
}

export function parseVersionValue<T>(schema: z.ZodType<T>, value: unknown): T {
  return parseUnknownValue(
    schema,
    value,
    ProjectVersioningErrorCodes.gitQueryFailed,
    '版本记录无法读取'
  )
}

export async function listVersionDocuments(directory: string): Promise<string[]> {
  const names = await listDocumentNames(directory, versionReadFailure)
  return names.filter((name) => name.endsWith('.json') && !isTemporaryDocumentName(name))
}
