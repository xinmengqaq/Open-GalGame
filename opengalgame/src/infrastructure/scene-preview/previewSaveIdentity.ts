import { createHash } from 'node:crypto'

import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { PREVIEW_SAVE_SOURCE_MODULE } from '@application/scene-preview/ports/PreviewSaveVersionGateway'

export function previewCallerOperationId(
  projectId: string,
  sceneId: string,
  requestId: string
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([PREVIEW_SAVE_SOURCE_MODULE, projectId, sceneId, requestId]))
    .digest('hex')
  const callerOperationId = `preview-${digest.slice(0, 64)}`
  if (!OPERATION_ID_PATTERN.test(callerOperationId)) {
    throw new Error('预览保存身份不符合版本格式')
  }
  return callerOperationId
}
