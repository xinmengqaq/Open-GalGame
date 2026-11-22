import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import type {
  CloseSceneGenerationCandidatePreviewDTO,
  OpenSceneGenerationCandidatePreviewDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidatePreviewEventVO,
  SceneGenerationCandidatePreviewListener,
  SceneGenerationCandidatePreviewVO
} from '../vo/SceneGenerationRenderVO'

export interface SceneCandidatePreviewGateway {
  openPublishedCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO,
    context: CandidatePreviewOpenContext
  ): Promise<SceneGenerationCandidatePreviewOpen>

  closeCandidatePreview(request: CloseSceneGenerationCandidatePreviewDTO): Promise<void>

  invalidateCandidatePreviewSessions(scope: {
    projectId: string
    sceneId: string
    operationId: string
    candidateSnapshotId?: string
  }): Promise<void>

  close(): Promise<void>

  subscribeCandidatePreviewEvents(listener: SceneGenerationCandidatePreviewListener): () => void

  readCandidatePreviewEvent(
    previewSessionId: string
  ): SceneGenerationCandidatePreviewEventVO | undefined
}

export type SceneGenerationCandidatePreviewOpen = {
  readonly preview: SceneGenerationCandidatePreviewVO
  readonly stage: Promise<void>
}

export type CandidatePreviewOpenContext = {
  readonly entryFile: string
  readonly sceneName: string
}

export function candidatePreviewOpenContext(
  source: SceneSourceLocation
): CandidatePreviewOpenContext {
  const directory = source.sceneDirectory.replaceAll('\\', '/').replace(/\/+$/, '')
  const entry = source.entryFile.replaceAll('\\', '/').replace(/^\/+/, '')
  const entryFile = entry.includes('/') ? entry : directory === '' ? entry : `${directory}/${entry}`
  const fileName = entryFile.slice(entryFile.lastIndexOf('/') + 1)
  const extension = fileName.lastIndexOf('.')
  const sceneName = extension > 0 ? fileName.slice(0, extension) : fileName
  if (entryFile.trim() === '' || sceneName.trim() === '') {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选预览入口无效' })
  }
  return { entryFile, sceneName }
}
