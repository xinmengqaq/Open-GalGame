import { AppException } from '@common/errors/AppException'

import type { ReadScenePreviewAvailabilityDTO } from '../../dto/ScenePreviewAvailabilityDTO'
import type {
  ScenePreviewArtifactGateway,
  ScenePreviewArtifactReport
} from '../../ports/ScenePreviewArtifactGateway'
import type { ScenePreviewAvailabilityVO } from '../../vo/ScenePreviewAvailabilityVO'
import { previewFailure } from './previewErrorMapping'

const blockedMessages = {
  noArtifact: '当前场景还没有可预览的内容',
  readUnavailable: '当前场景暂时无法读取'
} as const

/** 只判断当前场景的产物可用性，不读取正文、不接触运行时。 */
export class PreviewAvailabilityService {
  constructor(private readonly deps: { readonly artifacts: ScenePreviewArtifactGateway }) {}

  async readScenePreviewAvailability(
    request: ReadScenePreviewAvailabilityDTO
  ): Promise<ScenePreviewAvailabilityVO> {
    requireSceneIdentity(request.projectId, request.sceneId)
    let report: ScenePreviewArtifactReport
    try {
      report = await this.deps.artifacts.readSceneArtifact(request)
    } catch (error) {
      if (error instanceof AppException) {
        return {
          status: 'blocked',
          reason: 'sceneUnavailable',
          message: '当前场景不可用'
        }
      }
      return {
        status: 'blocked',
        reason: 'readUnavailable',
        message: blockedMessages.readUnavailable
      }
    }
    if (report.status === 'available') return { status: 'available' }
    const reason = report.status === 'missing' ? 'noArtifact' : 'readUnavailable'
    return { status: 'blocked', reason, message: blockedMessages[reason] }
  }
}

export function requireSceneIdentity(projectId: string, sceneId: string): void {
  if (projectId.trim() === '' || sceneId.trim() === '') throw previewFailure('invalidRequest')
}

export function requireRequestId(requestId: string): void {
  if (requestId.trim() === '') throw previewFailure('invalidRequest')
}
