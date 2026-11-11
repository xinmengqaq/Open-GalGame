import { webUtils } from 'electron'

import type { DesktopBridge } from '../client/DesktopBridge'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectProgressVO } from '@application/projects/vo/ProjectVO'
import type {
  ClearVersionHistoryDTO,
  ListVersionHistoryDTO,
  UndoVersionHistoryDTO
} from '@application/project-versioning/dto/ProjectVersioningDTO'
import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type {
  SceneGenerationCandidatePreviewEventVO,
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type {
  DialogueSaveSettlementVO,
  SaveDialogueChangesVO
} from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewStageResultVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '@application/scene-preview/vo/ScenePreviewAvailabilityVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'

export interface DesktopTransport {
  invoke(channel: string, input?: unknown): Promise<unknown>
  /**
   * @param listener - 不含 Electron event 的回调。
   */
  subscribe(channel: string, listener: (value: unknown) => void): () => void
}

/** 建立固定桥接，不向表现层暴露通用 IPC。 */
export function createDesktopBridge(transport: DesktopTransport): DesktopBridge {
  return {
    chooseSaveLocation: () =>
      transport.invoke('project:choose-save-location') as ReturnType<
        DesktopBridge['chooseSaveLocation']
      >,
    /** 清除新建待用的保存位置。 */
    clearSaveLocation: () =>
      transport.invoke('project:clear-save-location') as ReturnType<
        DesktopBridge['clearSaveLocation']
      >,
    createProject: (request) =>
      transport.invoke('project:create', request) as ReturnType<DesktopBridge['createProject']>,
    importProject: (request) =>
      transport.invoke('project:import', request) as ReturnType<DesktopBridge['importProject']>,
    /** 读取一页本机已登记项目。 */
    listProjects: (request) =>
      transport.invoke('project:list', request) as ReturnType<DesktopBridge['listProjects']>,
    openProject: (request) =>
      transport.invoke('project:open', request) as ReturnType<DesktopBridge['openProject']>,
    renameProject: (request) =>
      transport.invoke('project:rename', request) as ReturnType<DesktopBridge['renameProject']>,
    unregisterProject: (request) =>
      transport.invoke('project:unregister', request) as ReturnType<
        DesktopBridge['unregisterProject']
      >,
    /** 核对已登记工程的默认场景和作品基线。 */
    ensureProjectWorkspace: (request) =>
      transport.invoke('project:ensure-workspace', request) as ReturnType<
        DesktopBridge['ensureProjectWorkspace']
      >,
    /** 只读检查已登记工程的工作区，不补建。 */
    inspectProjectWorkspace: (request) =>
      transport.invoke('project:inspect-workspace', request) as ReturnType<
        DesktopBridge['inspectProjectWorkspace']
      >,
    /** 检查工程输入来源及画布编排文件。 */
    inspectProjectFiles: (request) =>
      transport.invoke('project-files:inspect', request) as ReturnType<
        DesktopBridge['inspectProjectFiles']
      >,
    listProjectInputSources: (request) =>
      transport.invoke('project-files:list-input-sources', request) as ReturnType<
        DesktopBridge['listProjectInputSources']
      >,
    /** 批量读取来源内容及本次读取版本。 */
    readProjectInputSources: (request) =>
      transport.invoke('project-files:read-input-sources', request) as ReturnType<
        DesktopBridge['readProjectInputSources']
      >,
    /** 按来源身份读取工程内媒体字节。 */
    readProjectMedia: (request) =>
      transport.invoke('project-files:read-media', request) as ReturnType<
        DesktopBridge['readProjectMedia']
      >,
    /** 读取场景画布模块的已保存编排。 */
    readSceneCanvasArrangement: (request) =>
      transport.invoke('scene-canvas:read-arrangement', request) as ReturnType<
        DesktopBridge['readSceneCanvasArrangement']
      >,
    createSceneCanvasSourceCard: (request) =>
      transport.invoke('scene-canvas:create-source-card', request) as ReturnType<
        DesktopBridge['createSceneCanvasSourceCard']
      >,
    createSceneCanvasPromptCard: (request) =>
      transport.invoke('scene-canvas:create-prompt-card', request) as ReturnType<
        DesktopBridge['createSceneCanvasPromptCard']
      >,
    createSceneCanvasFieldCard: (request) =>
      transport.invoke('scene-canvas:create-field-card', request) as ReturnType<
        DesktopBridge['createSceneCanvasFieldCard']
      >,
    editSceneCanvasCard: (request) =>
      transport.invoke('scene-canvas:edit-card', request) as ReturnType<
        DesktopBridge['editSceneCanvasCard']
      >,
    editSceneCanvasPromptBody: (request) =>
      transport.invoke('scene-canvas:edit-prompt-body', request) as ReturnType<
        DesktopBridge['editSceneCanvasPromptBody']
      >,
    /** 绑定或清空字段预设。 */
    bindSceneCanvasFieldCardPreset: (request) =>
      transport.invoke('scene-canvas:bind-field-card-preset', request) as ReturnType<
        DesktopBridge['bindSceneCanvasFieldCardPreset']
      >,
    editSceneCanvasMediaRole: (request) =>
      transport.invoke('scene-canvas:edit-media-role', request) as ReturnType<
        DesktopBridge['editSceneCanvasMediaRole']
      >,
    copySceneCanvasCard: (request) =>
      transport.invoke('scene-canvas:copy-card', request) as ReturnType<
        DesktopBridge['copySceneCanvasCard']
      >,
    deleteSceneCanvasCard: (request) =>
      transport.invoke('scene-canvas:delete-card', request) as ReturnType<
        DesktopBridge['deleteSceneCanvasCard']
      >,
    connectSceneCanvasCards: (request) =>
      transport.invoke('scene-canvas:connect-cards', request) as ReturnType<
        DesktopBridge['connectSceneCanvasCards']
      >,
    disconnectSceneCanvasCards: (request) =>
      transport.invoke('scene-canvas:disconnect-cards', request) as ReturnType<
        DesktopBridge['disconnectSceneCanvasCards']
      >,
    editSceneCanvasRelationName: (request) =>
      transport.invoke('scene-canvas:edit-relation-name', request) as ReturnType<
        DesktopBridge['editSceneCanvasRelationName']
      >,
    attachSceneCanvasRelationRecord: (request) =>
      transport.invoke('scene-canvas:attach-relation-record', request) as ReturnType<
        DesktopBridge['attachSceneCanvasRelationRecord']
      >,
    detachSceneCanvasRelationRecord: (request) =>
      transport.invoke('scene-canvas:detach-relation-record', request) as ReturnType<
        DesktopBridge['detachSceneCanvasRelationRecord']
      >,
    saveSceneCanvasArrangement: (request) =>
      transport.invoke('scene-canvas:save-arrangement', request) as ReturnType<
        DesktopBridge['saveSceneCanvasArrangement']
      >,
    chooseProjectFiles: () =>
      transport.invoke('project-files:choose-files', {}) as ReturnType<
        DesktopBridge['chooseProjectFiles']
      >,
    importProjectFiles: (request) =>
      transport.invoke('project-files:import', request) as ReturnType<
        DesktopBridge['importProjectFiles']
      >,
    /** 用系统默认程序打开工程文件。 */
    openProjectFile: (request) =>
      transport.invoke('project-files:open', request) as ReturnType<
        DesktopBridge['openProjectFile']
      >,
    renameProjectFile: (request) =>
      transport.invoke('project-files:rename', request) as ReturnType<
        DesktopBridge['renameProjectFile']
      >,
    /** 删除工程文件及来源记录。 */
    deleteProjectFile: (request) =>
      transport.invoke('project-files:delete', request) as ReturnType<
        DesktopBridge['deleteProjectFile']
      >,
    createProjectTextFile: (request) =>
      transport.invoke('project-files:create-text', request) as ReturnType<
        DesktopBridge['createProjectTextFile']
      >,
    /** 覆盖已导入文档的正文。 */
    updateProjectTextFileBody: (request) =>
      transport.invoke('project-files:update-text-body', request) as ReturnType<
        DesktopBridge['updateProjectTextFileBody']
      >,
    createProjectFolder: (request) =>
      transport.invoke('project-files:create-folder', request) as ReturnType<
        DesktopBridge['createProjectFolder']
      >,
    copyProjectFile: (request) =>
      transport.invoke('project-files:copy-file', request) as ReturnType<
        DesktopBridge['copyProjectFile']
      >,
    moveProjectFile: (request) =>
      transport.invoke('project-files:move-file', request) as ReturnType<
        DesktopBridge['moveProjectFile']
      >,
    copyProjectFolder: (request) =>
      transport.invoke('project-files:copy-folder', request) as ReturnType<
        DesktopBridge['copyProjectFolder']
      >,
    /** 按操作标识核对提交是否已经落地。 */
    readProjectFileOperation: (request) =>
      transport.invoke('project-files:read-operation', request) as ReturnType<
        DesktopBridge['readProjectFileOperation']
      >,
    renameProjectFolder: (request) =>
      transport.invoke('project-files:rename-folder', request) as ReturnType<
        DesktopBridge['renameProjectFolder']
      >,
    readProjectFolderDeletionPlan: (request) =>
      transport.invoke('project-files:folder-deletion-plan', request) as ReturnType<
        DesktopBridge['readProjectFolderDeletionPlan']
      >,
    deleteProjectFolder: (request) =>
      transport.invoke('project-files:delete-folder', request) as ReturnType<
        DesktopBridge['deleteProjectFolder']
      >,
    /** 把拖入的磁盘文件转成本机路径。不经过导入通道。 */
    pathForDroppedFile: (file) => {
      try {
        const path = webUtils.getPathForFile(file)
        if (path === '') {
          return Promise.resolve({ code: ErrorCodes.invalidRequest, msg: '不是磁盘文件' })
        }
        return Promise.resolve({ code: ErrorCodes.success, msg: '已取得文件路径', data: path })
      } catch {
        return Promise.resolve({ code: ErrorCodes.invalidRequest, msg: '不是磁盘文件' })
      }
    },
    getSettingsSummary: () =>
      transport.invoke('connection:get-summary') as ReturnType<DesktopBridge['getSettingsSummary']>,
    testConnection: (request) =>
      transport.invoke('connection:test', request) as ReturnType<DesktopBridge['testConnection']>,
    saveSettings: (request) =>
      transport.invoke('connection:save', request) as ReturnType<DesktopBridge['saveSettings']>,
    listModels: (request) =>
      transport.invoke('connection:list-models', request) as ReturnType<
        DesktopBridge['listModels']
      >,
    listVersionHistory: (request: ListVersionHistoryDTO) =>
      transport.invoke('project-versioning:list-history', request) as Promise<
        AjaxResult<VersionHistoryPageVO>
      >,
    undoVersionHistoryEntry: (request: UndoVersionHistoryDTO) =>
      transport.invoke('project-versioning:undo-history-entry', request) as Promise<
        AjaxResult<VersionHistoryUndoVO>
      >,
    clearVersionHistory: (request: ClearVersionHistoryDTO) =>
      transport.invoke('project-versioning:clear-history', request) as Promise<
        AjaxResult<VersionHistoryClearVO>
      >,
    onProjectProgress: (listener) =>
      transport.subscribe('project:progress', (value) => listener(value as ProjectProgressVO)),
    startSceneGeneration: (request) =>
      transport.invoke('scene-generation:start', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    retrySceneGenerationRepair: (request) =>
      transport.invoke('scene-generation:retry-repair', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    getSceneGenerationStatus: (request) =>
      transport.invoke('scene-generation:status', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    getLatestSceneGeneration: (request) =>
      transport.invoke('scene-generation:latest', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO | null>
      >,
    replySceneGeneration: (request) =>
      transport.invoke('scene-generation:reply', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    pauseSceneGeneration: (request) =>
      transport.invoke('scene-generation:pause', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    resumeSceneGeneration: (request) =>
      transport.invoke('scene-generation:resume', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    cancelSceneGeneration: (request) =>
      transport.invoke('scene-generation:cancel', request) as Promise<
        AjaxResult<SceneGenerationRenderStatusVO>
      >,
    listSceneGenerationHistory: (request) =>
      transport.invoke('scene-generation:list-history', request) as Promise<
        AjaxResult<readonly SceneGenerationHistorySummaryVO[]>
      >,
    readSceneGenerationCheckpoint: (request) =>
      transport.invoke('scene-generation:read-checkpoint', request) as Promise<
        AjaxResult<SceneGenerationHistorySummaryVO>
      >,
    openSceneGenerationPreview: (request) =>
      transport.invoke('scene-generation:open-preview', request) as Promise<
        AjaxResult<SceneGenerationCandidatePreviewVO>
      >,
    closeSceneGenerationPreview: (request) =>
      transport.invoke('scene-generation:close-preview', request) as Promise<AjaxResult<null>>,
    subscribeSceneGenerationProgress: (request) =>
      transport.invoke('scene-generation:progress', request) as Promise<AjaxResult<null>>,
    onSceneGenerationProgress: (listener) =>
      transport.subscribe('scene-generation:progress', (value) =>
        listener(value as SceneGenerationRenderProgressEventVO)
      ),
    readScenePreviewAvailability: (request) =>
      transport.invoke('scene-preview:availability', request) as Promise<
        AjaxResult<ScenePreviewAvailabilityVO>
      >,
    openScenePreview: (request) =>
      transport.invoke('scene-preview:open', request) as Promise<AjaxResult<ScenePreviewSessionVO>>,
    preparePreviewStage: (request) =>
      transport.invoke('scene-preview:prepare', request) as Promise<
        AjaxResult<PreviewStageResultVO>
      >,
    previewDialogueDraft: (request) =>
      transport.invoke('scene-preview:draft', request) as Promise<AjaxResult<PreviewDraftResultVO>>,
    saveDialogueChanges: (request) =>
      transport.invoke('scene-preview:save', request) as Promise<AjaxResult<SaveDialogueChangesVO>>,
    readDialogueSaveSettlement: (request) =>
      transport.invoke('scene-preview:settlement', request) as Promise<
        AjaxResult<DialogueSaveSettlementVO>
      >,
    selectPreviewDialogue: (request) =>
      transport.invoke('scene-preview:select-dialogue', request) as Promise<
        AjaxResult<PreviewCommandResultVO>
      >,
    playPreviousDialogue: (request) =>
      transport.invoke('scene-preview:previous-dialogue', request) as Promise<
        AjaxResult<PreviewCommandResultVO>
      >,
    playNextDialogue: (request) =>
      transport.invoke('scene-preview:next-dialogue', request) as Promise<
        AjaxResult<PreviewCommandResultVO>
      >,
    closeScenePreview: (request) =>
      transport.invoke('scene-preview:close', request) as Promise<AjaxResult<null>>,
    subscribeScenePreviewRuntime: (request) =>
      transport.invoke('scene-preview:subscribe', request) as Promise<AjaxResult<null>>,
    onScenePreviewRuntime: (listener) => transport.subscribe('scene-preview:runtime', listener),
    readCandidatePreview: (request) =>
      transport.invoke('scene-preview:read-candidate', request) as Promise<
        AjaxResult<CandidatePreviewVO>
      >,
    readCandidatePreviewEvent: (request) =>
      transport.invoke('scene-preview:candidate-event', request) as Promise<
        AjaxResult<SceneGenerationCandidatePreviewEventVO | null>
      >,
    onCandidatePreviewReady: (listener) => transport.subscribe('scene-preview:ready', listener),
    onCandidatePreviewStageFailed: (listener) =>
      transport.subscribe('scene-preview:stage-failed', listener),
    onCandidatePreviewInvalidated: (listener) =>
      transport.subscribe('scene-preview:invalidated', listener),
    exportSavedScene: (request) =>
      transport.invoke('scene-export:export-saved-scene', request) as Promise<
        AjaxResult<SceneExportResultVO>
      >,
    readLatestPreviewSave: (request) =>
      transport.invoke('scene-export:read-latest-preview-save', request) as Promise<
        AjaxResult<PreviewSaveVersionVO | null>
      >,
    openDirectory: (request) =>
      transport.invoke('system:open-directory', request) as Promise<AjaxResult<null>>
  }
}
