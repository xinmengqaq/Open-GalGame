import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

import { projectDocumentFailure } from './projectDocumentFailure'
import {
  deleteJsonDocument,
  isTemporaryDocumentName,
  listDocumentNames,
  readJsonDocument,
  writeJsonDocument
} from '../storage/jsonDocument'
import { parseUnknownValue } from '../validation/parseUnknownValue'
import type { ProjectOperation } from '@application/projects/models/ProjectOperation'
import type { ProjectOperationJournalGateway } from '@application/projects/ports/ProjectOperationJournalGateway'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

const PROJECT_OPERATIONS_DIRECTORY_NAME = 'operations'

const DOCUMENT_EXTENSION = '.json'
const projectOperationDocumentSchema = z.strictObject({
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  fingerprint: z.string(),
  kind: z.enum(['created', 'imported']),
  initialize: z.boolean(),
  location: z.strictObject({ directory: z.string().refine(isAbsolute) }),
  project: z.strictObject({ id: z.string(), name: z.string(), synopsis: z.string() }),
  stage: z.enum(['prepared', 'published', 'completed'])
})

type ProjectOperationDocument = z.infer<typeof projectOperationDocumentSchema>

const failure = projectDocumentFailure(ProjectErrorCodes.storageFailed, '项目恢复记录读写失败')
const corruptedMsg = '项目恢复记录损坏，请保留原工程排查'

function isOperationDocumentName(name: string): boolean {
  return (
    !isTemporaryDocumentName(name) &&
    name.endsWith(DOCUMENT_EXTENSION) &&
    OPERATION_ID_PATTERN.test(name.slice(0, -DOCUMENT_EXTENSION.length))
  )
}

export class LocalProjectOperationJournalGatewayImpl implements ProjectOperationJournalGateway {
  constructor(private readonly userDirectory: string) {}

  async find(operationId: string): Promise<ProjectOperation | null> {
    const value = await readJsonDocument(this.operationPath(operationId), failure)
    if (value === null) return null
    const operation = parseUnknownValue(
      projectOperationDocumentSchema,
      value,
      failure.code,
      corruptedMsg
    )
    if (operation.operationId !== operationId)
      throw new AppException({ code: failure.code, msg: corruptedMsg })
    return operation
  }

  async begin(operation: ProjectOperation): Promise<void> {
    await writeJsonDocument(
      this.operationPath(operation.operationId),
      operation satisfies ProjectOperationDocument,
      failure
    )
  }

  async markPublished(operationId: string): Promise<void> {
    await this.recordStage(operationId, 'published')
  }

  async complete(operationId: string): Promise<void> {
    await this.recordStage(operationId, 'completed')
  }

  async remove(operationId: string): Promise<void> {
    const operation = await this.find(operationId)
    if (operation?.stage !== 'prepared') return
    await deleteJsonDocument(this.operationPath(operationId), failure)
  }

  async listIncomplete(): Promise<string[]> {
    const names = await listDocumentNames(this.operationsDirectory, failure)
    const incomplete: string[] = []
    for (const name of names.filter(isOperationDocumentName).sort()) {
      const operationId = name.slice(0, -DOCUMENT_EXTENSION.length)
      try {
        const operation = await this.find(operationId)
        if (operation && operation.stage !== 'completed') incomplete.push(operationId)
      } catch (error) {
        if (!(error instanceof AppException)) throw error
        incomplete.push(operationId)
      }
    }
    return incomplete
  }

  private get operationsDirectory(): string {
    return join(this.userDirectory, PROJECT_OPERATIONS_DIRECTORY_NAME)
  }

  private operationPath(operationId: string): string {
    if (!OPERATION_ID_PATTERN.test(operationId))
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '操作标识格式不正确' })
    return join(this.operationsDirectory, `${operationId}${DOCUMENT_EXTENSION}`)
  }

  private async recordStage(operationId: string, stage: ProjectOperation['stage']): Promise<void> {
    const operation = await this.find(operationId)
    if (!operation) return
    await writeJsonDocument(this.operationPath(operationId), { ...operation, stage }, failure)
  }
}
