import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { PREVIEW_SAVE_SOURCE_MODULE } from '@application/scene-preview/ports/PreviewSaveVersionGateway'

import { previewCallerOperationId } from './previewSaveIdentity'
import { readPreviewSaveRecord, type PreviewSaveRecord } from './previewSaveRecord'

export type PreviewSaveAuthority = {
  readonly callerOperationId: string
  readonly record: PreviewSaveRecord
  readonly settlement: VersionSettlementVO
}

/**
 * 预览保存的唯一权威读取：按 requestId 派生 caller 身份，核对保存记录、
 * scene-preview caller link 和已提交/无变更结算。
 * 查询与导出点击必须共用这份核对，避免查询点亮一个点击时会被拒绝的来源。
 */
export async function readPreviewSaveAuthority(params: {
  readonly root: string
  readonly versioning: ProjectVersioningApplicationService
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
}): Promise<PreviewSaveAuthority | null> {
  const callerOperationId = previewCallerOperationId(
    params.projectId,
    params.sceneId,
    params.requestId
  )
  const record = await readPreviewSaveRecord(params.root, callerOperationId)
  if (
    !record ||
    record.projectId !== params.projectId ||
    record.sceneId !== params.sceneId ||
    record.callerOperationId !== callerOperationId
  ) {
    return null
  }
  const link = await params.versioning.findCallerOperation({
    sourceModule: PREVIEW_SAVE_SOURCE_MODULE,
    callerOperationId
  })
  if (
    !link ||
    link.projectId !== params.projectId ||
    link.sourceModule !== PREVIEW_SAVE_SOURCE_MODULE ||
    link.callerOperationId !== callerOperationId ||
    link.operationId !== record.operationId
  ) {
    return null
  }
  const settlement = await params.versioning.readOperationSettlement({
    projectId: params.projectId,
    operationId: record.operationId
  })
  if (settlement.state !== '已提交' && settlement.state !== '无变更') return null
  return { callerOperationId, record, settlement }
}
