import { z } from 'zod'

import type {
  VersionClearMarker,
  VersionHistoryBinding,
  VersionHistoryFact,
  VersionHistoryGateway,
  VersionHistoryProjection
} from '@application/project-versioning/ports/VersionHistoryGateway'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { enqueueWorkWrite } from '@infrastructure/git/transaction/workWriteBoundary'

import { resolveProjectWorkRoot } from './projectWorkRoot'
import {
  parseVersionValue,
  readVersionValue,
  versionDocumentPath,
  writeVersionValue
} from './versionStore'

const CHANGED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u
const HISTORY_DIRECTORY = ['opengalgame', 'version-history']

const historyEntrySchema = z.strictObject({
  historyId: z.string().regex(OPERATION_ID_PATTERN),
  projectId: z.string().min(1),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  sourceModule: z.string().min(1),
  targets: z.array(z.strictObject({ kind: z.string().min(1), id: z.string().min(1) })),
  saveMode: z.enum(['manual', 'system']),
  contentSource: z.enum(['operation', 'ai']),
  title: z.string().min(1),
  summary: z.string().min(1),
  createdAt: z.string().regex(CHANGED_AT_PATTERN),
  state: z.enum(['已提交', '已回退']),
  canUndo: z.boolean(),
  canClear: z.boolean()
})

const projectionSchema = z.strictObject({
  formatVersion: z.literal(1),
  projectId: z.string().min(1),
  complete: z.boolean(),
  entries: z.array(historyEntrySchema)
})

const clearSchema = z.strictObject({
  formatVersion: z.literal(1),
  projectId: z.string().min(1),
  historyIds: z.array(z.string().regex(OPERATION_ID_PATTERN))
})

/**
 * 保存可重建的历史投影和独立的清理标记。
 * 不删除作品文件、提交或操作绑定。
 */
export class FileVersionHistoryGateway implements VersionHistoryGateway {
  constructor(private readonly userDirectory: string) {}

  async readProjection(projectId: string): Promise<VersionHistoryProjection> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    const value = await readVersionValue(await historyPath(root, 'projection.json'))
    if (value === null) return { complete: true, entries: [] }
    const document = parseVersionValue(projectionSchema, value)
    if (document.projectId !== projectId) throw unreadableHistory()
    return { complete: document.complete, entries: document.entries }
  }

  async writeProjection(projectId: string, entries: readonly VersionHistoryFact[]): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    await enqueueWorkWrite(root, async () => {
      assertEntries(projectId, entries)
      await writeVersionValue(await historyPath(root, 'projection.json'), {
        formatVersion: 1,
        projectId,
        complete: true,
        entries
      })
    })
  }

  async markIncomplete(projectId: string): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    await enqueueWorkWrite(root, async () => {
      const current = await this.readProjection(projectId)
      await writeVersionValue(await historyPath(root, 'projection.json'), {
        formatVersion: 1,
        projectId,
        complete: false,
        entries: current.entries
      })
    })
  }

  async readClearMarkers(projectId: string): Promise<readonly VersionClearMarker[]> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    const value = await readVersionValue(await historyPath(root, 'cleared.json'))
    if (value === null) return []
    const document = parseVersionValue(clearSchema, value)
    if (document.projectId !== projectId) throw unreadableHistory()
    return document.historyIds.map((historyId) => ({ projectId, historyId }))
  }

  async persistClearMarkers(projectId: string, historyIds: readonly string[]): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, projectId)
    await enqueueWorkWrite(root, async () => {
      const existing = await this.readClearMarkers(projectId)
      const merged = [...existing.map((marker) => marker.historyId)]
      for (const historyId of historyIds) {
        if (!OPERATION_ID_PATTERN.test(historyId)) {
          throw new AppException({
            code: ProjectVersioningErrorCodes.invalidOperationIdentity,
            msg: '历史身份不正确'
          })
        }
        if (!merged.includes(historyId)) merged.push(historyId)
      }
      await writeVersionValue(await historyPath(root, 'cleared.json'), {
        formatVersion: 1,
        projectId,
        historyIds: merged
      })
    })
  }

  async resolveActive(projectId: string, historyId: string): Promise<VersionHistoryBinding | null> {
    if (!OPERATION_ID_PATTERN.test(historyId)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.invalidOperationIdentity,
        msg: '历史身份不正确'
      })
    }
    const projection = await this.readProjection(projectId)
    if (!projection.complete) throw unreadableHistory()
    const markers = await this.readClearMarkers(projectId)
    if (markers.some((marker) => marker.historyId === historyId)) return null
    const entry = projection.entries.find((item) => item.historyId === historyId)
    return entry ? { operationId: entry.operationId } : null
  }
}

function assertEntries(projectId: string, entries: readonly VersionHistoryFact[]): void {
  const document = {
    formatVersion: 1 as const,
    projectId,
    complete: true,
    entries
  }
  const parsed = parseVersionValue(projectionSchema, document)
  if (parsed.entries.some((entry) => entry.projectId !== projectId)) throw unreadableHistory()
}

function historyPath(projectRoot: string, name: string): Promise<string> {
  return versionDocumentPath(projectRoot, HISTORY_DIRECTORY, name)
}

function unreadableHistory(): AppException {
  return new AppException({
    code: ProjectVersioningErrorCodes.gitQueryFailed,
    msg: '修订历史无法读取'
  })
}
