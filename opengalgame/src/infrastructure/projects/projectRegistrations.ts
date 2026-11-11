import { join } from 'node:path'
import { z } from 'zod'

import { projectDocumentFailure } from './projectDocumentFailure'
import { readJsonDocument, writeJsonDocument } from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const PROJECT_REGISTRATIONS_FILE_NAME = 'projects.json'

const projectRegistrationsDocumentSchema = z.strictObject({
  registrations: z.array(
    z.strictObject({ id: z.string(), directory: z.string(), operationId: z.string() })
  )
})

type ProjectRegistrationsDocument = z.infer<typeof projectRegistrationsDocumentSchema>

const failure = projectDocumentFailure(ProjectErrorCodes.storageFailed, '本机项目登记读写失败')

/**
 * @returns 全部登记；文件不存在时为空。
 * @throws {AppException} 文件无法读取或内容损坏。
 */
export async function readProjectRegistrations(
  userDirectory: string
): Promise<ProjectRegistrationsDocument['registrations']> {
  const value = await readJsonDocument(
    join(userDirectory, PROJECT_REGISTRATIONS_FILE_NAME),
    failure
  )
  if (value === null) return []
  const file = parseUnknownValue(
    projectRegistrationsDocumentSchema,
    value,
    failure.code,
    '本机项目登记数据损坏'
  )
  return file.registrations
}

/**
 * 整份替换本机工程登记文件。调用方已在本机串行执行内完成读改写。
 * @throws {AppException} 写入失败。
 */
export async function writeProjectRegistrations(
  userDirectory: string,
  registrations: ProjectRegistrationsDocument['registrations']
): Promise<void> {
  await writeJsonDocument(
    join(userDirectory, PROJECT_REGISTRATIONS_FILE_NAME),
    { registrations } satisfies ProjectRegistrationsDocument,
    failure
  )
}
