import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { ReadLatestPreviewSaveDTO } from '@application/scene-export/dto/ReadLatestPreviewSaveDTO'
import type {
  PreviewSaveVersionCandidate,
  PreviewSaveVersionQueryGateway
} from '@application/scene-export/ports/PreviewSaveVersionQueryGateway'

import { resolveRepositoryMetadata } from '../git/containedPath'
import { resolveProjectWorkRoot } from '../project-versioning/projectWorkRoot'
import { listVersionDocuments } from '../project-versioning/versionStore'
import {
  PREVIEW_SAVE_DIRECTORY,
  readPreviewSaveRecord
} from '../scene-preview/previewSaveRecord'

/**
 * 从工程 Git 元数据里的预览保存记录中查询已结算版本。
 * 记录损坏、缺少内容摘要或结算状态不可核对时跳过，不中断整次查询。
 */
export class LocalPreviewSaveVersionQueryGateway implements PreviewSaveVersionQueryGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly versioning: ProjectVersioningApplicationService
  ) {}

  async listSettledPreviewSaves(
    request: ReadLatestPreviewSaveDTO
  ): Promise<readonly PreviewSaveVersionCandidate[]> {
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const directory = await resolveRepositoryMetadata(root, PREVIEW_SAVE_DIRECTORY)
    const names = await listVersionDocuments(directory)
    const candidates: PreviewSaveVersionCandidate[] = []
    for (const name of names) {
      const candidate = await this.readCandidate(root, directory, name, request).catch(() => null)
      if (candidate) candidates.push(candidate)
    }
    return candidates
  }

  private async readCandidate(
    root: string,
    directory: string,
    name: string,
    request: ReadLatestPreviewSaveDTO
  ): Promise<PreviewSaveVersionCandidate | null> {
    const callerOperationId = name.slice(0, -'.json'.length)
    const record = await readPreviewSaveRecord(root, callerOperationId)
    if (!record) return null
    if (record.projectId !== request.projectId || record.sceneId !== request.sceneId) return null
    if (record.refusal !== undefined || record.contentDigest === undefined) return null
    const settlement = await this.versioning.readOperationSettlement({
      projectId: record.projectId,
      operationId: record.operationId
    })
    if (settlement.state !== '已提交' && settlement.state !== '无变更') return null
    const metadata = await stat(join(directory, name))
    return {
      projectId: record.projectId,
      sceneId: record.sceneId,
      requestId: record.requestId,
      revisionDigest: record.revisionDigest,
      contentBasis: {
        digest: record.contentDigest,
        parserVersion: record.parserVersion,
        engineVersion: record.engineVersion
      },
      savedAtMs: metadata.mtimeMs
    }
  }
}
