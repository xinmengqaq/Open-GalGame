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

/**
 * 固定候选修订的只读预览端口。
 * 应用层只传稳定身份；物化、路径和运行时由基础设施实现。
 */
export interface SceneCandidatePreviewGateway {
  /**
   * 从已发布候选修订建立短生命周期只读会话。
   * @throws {AppException} 修订缺失、归属不符、路径越界或运行时不能启动。
   */
  openPublishedCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO,
    context: CandidatePreviewOpenContext
  ): Promise<SceneGenerationCandidatePreviewOpen>

  /**
   * 关闭指定会话并释放其资源。
   * @throws {AppException} 会话不存在、不属于当前操作或关闭失败。
   */
  closeCandidatePreview(request: CloseSceneGenerationCandidatePreviewDTO): Promise<void>

  /**
   * 新候选、编辑或切换后使旧会话失效。
   * @throws {AppException} 资源释放失败。
   */
  invalidateCandidatePreviewSessions(scope: {
    projectId: string
    sceneId: string
    operationId: string
    candidateSnapshotId?: string
  }): Promise<void>

  /** 进程退出时释放全部预览运行时和物化目录。 */
  close(): Promise<void>

  /**
   * 订阅候选舞台事件。监听只留在主进程，返回退订函数。
   * 已订阅后，后续打开、失败和失效才会送达。
   */
  subscribeCandidatePreviewEvents(listener: SceneGenerationCandidatePreviewListener): () => void

  /**
   * 读取会话最后一个真实舞台事实，供稍后订阅的渲染端补投。
   * 不返回路径；没有事件时返回 undefined。
   */
  readCandidatePreviewEvent(
    previewSessionId: string
  ): SceneGenerationCandidatePreviewEventVO | undefined
}

/** 打开结果留在主进程。`preview` 才能进入 IPC，`stage` 只给同进程等待。 */
export type SceneGenerationCandidatePreviewOpen = {
  readonly preview: SceneGenerationCandidatePreviewVO
  readonly stage: Promise<void>
}

export type CandidatePreviewOpenContext = {
  readonly entryFile: string
  readonly sceneName: string
}

/** 用执行记录里的场景目录和入口文件名组装服务端上下文，不接受渲染层路径。 */
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
