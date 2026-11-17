import { webUtils } from 'electron'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { ProjectProgressVO } from '@application/projects/vo/ProjectVO'
import type { SceneGenerationRenderProgressEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import {
  desktopBridgeChannels,
  type DesktopBridgeEventChannel,
  type DesktopBridgeInvokeChannel
} from '@interfaces/contracts/desktopBridgeChannels'

/** preload 对渲染进程暴露的最小传输端口；通道只来自冻结清单。 */
export interface DesktopTransport {
  invoke(channel: DesktopBridgeInvokeChannel, input?: unknown): Promise<unknown>
  /**
   * @param listener - 不含 Electron event 的回调。
   */
  subscribe(channel: DesktopBridgeEventChannel, listener: (value: unknown) => void): () => void
}

const { event: eventChannels, invoke: invokeChannels } = desktopBridgeChannels

/** 建立固定桥接，不向表现层暴露通用 IPC。 */
export function createDesktopBridge(transport: DesktopTransport): DesktopBridge {
  return {
    chooseSaveLocation: () =>
      transport.invoke(invokeChannels.chooseSaveLocation) as ReturnType<
        DesktopBridge['chooseSaveLocation']
      >,
    /** 清除新建待用的保存位置。 */
    clearSaveLocation: () =>
      transport.invoke(invokeChannels.clearSaveLocation) as ReturnType<
        DesktopBridge['clearSaveLocation']
      >,
    createProject: (request) =>
      transport.invoke(invokeChannels.createProject, request) as ReturnType<
        DesktopBridge['createProject']
      >,
    importProject: (request) =>
      transport.invoke(invokeChannels.importProject, request) as ReturnType<
        DesktopBridge['importProject']
      >,
    /** 读取一页本机已登记项目。 */
    listProjects: (request) =>
      transport.invoke(invokeChannels.listProjects, request) as ReturnType<
        DesktopBridge['listProjects']
      >,
    openProject: (request) =>
      transport.invoke(invokeChannels.openProject, request) as ReturnType<
        DesktopBridge['openProject']
      >,
    renameProject: (request) =>
      transport.invoke(invokeChannels.renameProject, request) as ReturnType<
        DesktopBridge['renameProject']
      >,
    unregisterProject: (request) =>
      transport.invoke(invokeChannels.unregisterProject, request) as ReturnType<
        DesktopBridge['unregisterProject']
      >,
    /** 核对已登记工程的默认场景和作品基线。 */
    ensureProjectWorkspace: (request) =>
      transport.invoke(invokeChannels.ensureProjectWorkspace, request) as ReturnType<
        DesktopBridge['ensureProjectWorkspace']
      >,
    /** 只读检查已登记工程的工作区，不补建。 */
    inspectProjectWorkspace: (request) =>
      transport.invoke(invokeChannels.inspectProjectWorkspace, request) as ReturnType<
        DesktopBridge['inspectProjectWorkspace']
      >,
    /** 检查工程输入来源及画布编排文件。 */
    inspectProjectFiles: (request) =>
      transport.invoke(invokeChannels.inspectProjectFiles, request) as ReturnType<
        DesktopBridge['inspectProjectFiles']
      >,
    listProjectInputSources: (request) =>
      transport.invoke(invokeChannels.listProjectInputSources, request) as ReturnType<
        DesktopBridge['listProjectInputSources']
      >,
    /** 批量读取来源内容及本次读取版本。 */
    readProjectInputSources: (request) =>
      transport.invoke(invokeChannels.readProjectInputSources, request) as ReturnType<
        DesktopBridge['readProjectInputSources']
      >,
    /** 按来源身份读取工程内媒体字节。 */
    readProjectMedia: (request) =>
      transport.invoke(invokeChannels.readProjectMedia, request) as ReturnType<
        DesktopBridge['readProjectMedia']
      >,
    /** 读取场景画布模块的已保存编排。 */
    readSceneCanvasArrangement: (request) =>
      transport.invoke(invokeChannels.readSceneCanvasArrangement, request) as ReturnType<
        DesktopBridge['readSceneCanvasArrangement']
      >,
    createSceneCanvasSourceCard: (request) =>
      transport.invoke(invokeChannels.createSceneCanvasSourceCard, request) as ReturnType<
        DesktopBridge['createSceneCanvasSourceCard']
      >,
    createSceneCanvasPromptCard: (request) =>
      transport.invoke(invokeChannels.createSceneCanvasPromptCard, request) as ReturnType<
        DesktopBridge['createSceneCanvasPromptCard']
      >,
    createSceneCanvasFieldCard: (request) =>
      transport.invoke(invokeChannels.createSceneCanvasFieldCard, request) as ReturnType<
        DesktopBridge['createSceneCanvasFieldCard']
      >,
    editSceneCanvasCard: (request) =>
      transport.invoke(invokeChannels.editSceneCanvasCard, request) as ReturnType<
        DesktopBridge['editSceneCanvasCard']
      >,
    editSceneCanvasPromptBody: (request) =>
      transport.invoke(invokeChannels.editSceneCanvasPromptBody, request) as ReturnType<
        DesktopBridge['editSceneCanvasPromptBody']
      >,
    /** 绑定或清空字段预设。 */
    bindSceneCanvasFieldCardPreset: (request) =>
      transport.invoke(invokeChannels.bindSceneCanvasFieldCardPreset, request) as ReturnType<
        DesktopBridge['bindSceneCanvasFieldCardPreset']
      >,
    editSceneCanvasMediaRole: (request) =>
      transport.invoke(invokeChannels.editSceneCanvasMediaRole, request) as ReturnType<
        DesktopBridge['editSceneCanvasMediaRole']
      >,
    copySceneCanvasCard: (request) =>
      transport.invoke(invokeChannels.copySceneCanvasCard, request) as ReturnType<
        DesktopBridge['copySceneCanvasCard']
      >,
    deleteSceneCanvasCard: (request) =>
      transport.invoke(invokeChannels.deleteSceneCanvasCard, request) as ReturnType<
        DesktopBridge['deleteSceneCanvasCard']
      >,
    connectSceneCanvasCards: (request) =>
      transport.invoke(invokeChannels.connectSceneCanvasCards, request) as ReturnType<
        DesktopBridge['connectSceneCanvasCards']
      >,
    disconnectSceneCanvasCards: (request) =>
      transport.invoke(invokeChannels.disconnectSceneCanvasCards, request) as ReturnType<
        DesktopBridge['disconnectSceneCanvasCards']
      >,
    editSceneCanvasRelationName: (request) =>
      transport.invoke(invokeChannels.editSceneCanvasRelationName, request) as ReturnType<
        DesktopBridge['editSceneCanvasRelationName']
      >,
    attachSceneCanvasRelationRecord: (request) =>
      transport.invoke(invokeChannels.attachSceneCanvasRelationRecord, request) as ReturnType<
        DesktopBridge['attachSceneCanvasRelationRecord']
      >,
    detachSceneCanvasRelationRecord: (request) =>
      transport.invoke(invokeChannels.detachSceneCanvasRelationRecord, request) as ReturnType<
        DesktopBridge['detachSceneCanvasRelationRecord']
      >,
    saveSceneCanvasArrangement: (request) =>
      transport.invoke(invokeChannels.saveSceneCanvasArrangement, request) as ReturnType<
        DesktopBridge['saveSceneCanvasArrangement']
      >,
    chooseProjectFiles: () =>
      transport.invoke(invokeChannels.chooseProjectFiles, {}) as ReturnType<
        DesktopBridge['chooseProjectFiles']
      >,
    importProjectFiles: (request) =>
      transport.invoke(invokeChannels.importProjectFiles, request) as ReturnType<
        DesktopBridge['importProjectFiles']
      >,
    /** 用系统默认程序打开工程文件。 */
    openProjectFile: (request) =>
      transport.invoke(invokeChannels.openProjectFile, request) as ReturnType<
        DesktopBridge['openProjectFile']
      >,
    renameProjectFile: (request) =>
      transport.invoke(invokeChannels.renameProjectFile, request) as ReturnType<
        DesktopBridge['renameProjectFile']
      >,
    /** 删除工程文件及来源记录。 */
    deleteProjectFile: (request) =>
      transport.invoke(invokeChannels.deleteProjectFile, request) as ReturnType<
        DesktopBridge['deleteProjectFile']
      >,
    createProjectTextFile: (request) =>
      transport.invoke(invokeChannels.createProjectTextFile, request) as ReturnType<
        DesktopBridge['createProjectTextFile']
      >,
    /** 覆盖已导入文档的正文。 */
    updateProjectTextFileBody: (request) =>
      transport.invoke(invokeChannels.updateProjectTextFileBody, request) as ReturnType<
        DesktopBridge['updateProjectTextFileBody']
      >,
    createProjectFolder: (request) =>
      transport.invoke(invokeChannels.createProjectFolder, request) as ReturnType<
        DesktopBridge['createProjectFolder']
      >,
    copyProjectFile: (request) =>
      transport.invoke(invokeChannels.copyProjectFile, request) as ReturnType<
        DesktopBridge['copyProjectFile']
      >,
    moveProjectFile: (request) =>
      transport.invoke(invokeChannels.moveProjectFile, request) as ReturnType<
        DesktopBridge['moveProjectFile']
      >,
    copyProjectFolder: (request) =>
      transport.invoke(invokeChannels.copyProjectFolder, request) as ReturnType<
        DesktopBridge['copyProjectFolder']
      >,
    /** 按操作标识核对提交是否已经落地。 */
    readProjectFileOperation: (request) =>
      transport.invoke(invokeChannels.readProjectFileOperation, request) as ReturnType<
        DesktopBridge['readProjectFileOperation']
      >,
    recoverProjectFileOperations: (request) =>
      transport.invoke(invokeChannels.recoverProjectFileOperations, request) as ReturnType<
        DesktopBridge['recoverProjectFileOperations']
      >,
    renameProjectFolder: (request) =>
      transport.invoke(invokeChannels.renameProjectFolder, request) as ReturnType<
        DesktopBridge['renameProjectFolder']
      >,
    readProjectFolderDeletionPlan: (request) =>
      transport.invoke(invokeChannels.readProjectFolderDeletionPlan, request) as ReturnType<
        DesktopBridge['readProjectFolderDeletionPlan']
      >,
    deleteProjectFolder: (request) =>
      transport.invoke(invokeChannels.deleteProjectFolder, request) as ReturnType<
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
      transport.invoke(invokeChannels.getSettingsSummary) as ReturnType<
        DesktopBridge['getSettingsSummary']
      >,
    testConnection: (request) =>
      transport.invoke(invokeChannels.testConnection, request) as ReturnType<
        DesktopBridge['testConnection']
      >,
    saveSettings: (request) =>
      transport.invoke(invokeChannels.saveSettings, request) as ReturnType<
        DesktopBridge['saveSettings']
      >,
    listModels: (request) =>
      transport.invoke(invokeChannels.listModels, request) as ReturnType<
        DesktopBridge['listModels']
      >,
    listVersionHistory: (request) =>
      transport.invoke(invokeChannels.listVersionHistory, request) as ReturnType<
        DesktopBridge['listVersionHistory']
      >,
    undoVersionHistoryEntry: (request) =>
      transport.invoke(invokeChannels.undoVersionHistoryEntry, request) as ReturnType<
        DesktopBridge['undoVersionHistoryEntry']
      >,
    clearVersionHistory: (request) =>
      transport.invoke(invokeChannels.clearVersionHistory, request) as ReturnType<
        DesktopBridge['clearVersionHistory']
      >,
    onProjectProgress: (listener) =>
      transport.subscribe(eventChannels.onProjectProgress, (value) =>
        listener(value as ProjectProgressVO)
      ),
    startSceneGeneration: (request) =>
      transport.invoke(invokeChannels.startSceneGeneration, request) as ReturnType<
        DesktopBridge['startSceneGeneration']
      >,
    retrySceneGenerationRepair: (request) =>
      transport.invoke(invokeChannels.retrySceneGenerationRepair, request) as ReturnType<
        DesktopBridge['retrySceneGenerationRepair']
      >,
    getSceneGenerationStatus: (request) =>
      transport.invoke(invokeChannels.getSceneGenerationStatus, request) as ReturnType<
        DesktopBridge['getSceneGenerationStatus']
      >,
    getLatestSceneGeneration: (request) =>
      transport.invoke(invokeChannels.getLatestSceneGeneration, request) as ReturnType<
        DesktopBridge['getLatestSceneGeneration']
      >,
    replySceneGeneration: (request) =>
      transport.invoke(invokeChannels.replySceneGeneration, request) as ReturnType<
        DesktopBridge['replySceneGeneration']
      >,
    pauseSceneGeneration: (request) =>
      transport.invoke(invokeChannels.pauseSceneGeneration, request) as ReturnType<
        DesktopBridge['pauseSceneGeneration']
      >,
    resumeSceneGeneration: (request) =>
      transport.invoke(invokeChannels.resumeSceneGeneration, request) as ReturnType<
        DesktopBridge['resumeSceneGeneration']
      >,
    cancelSceneGeneration: (request) =>
      transport.invoke(invokeChannels.cancelSceneGeneration, request) as ReturnType<
        DesktopBridge['cancelSceneGeneration']
      >,
    listSceneGenerationHistory: (request) =>
      transport.invoke(invokeChannels.listSceneGenerationHistory, request) as ReturnType<
        DesktopBridge['listSceneGenerationHistory']
      >,
    readSceneGenerationCheckpoint: (request) =>
      transport.invoke(invokeChannels.readSceneGenerationCheckpoint, request) as ReturnType<
        DesktopBridge['readSceneGenerationCheckpoint']
      >,
    openSceneGenerationPreview: (request) =>
      transport.invoke(invokeChannels.openSceneGenerationPreview, request) as ReturnType<
        DesktopBridge['openSceneGenerationPreview']
      >,
    closeSceneGenerationPreview: (request) =>
      transport.invoke(invokeChannels.closeSceneGenerationPreview, request) as ReturnType<
        DesktopBridge['closeSceneGenerationPreview']
      >,
    subscribeSceneGenerationProgress: (request) =>
      transport.invoke(invokeChannels.subscribeSceneGenerationProgress, request) as ReturnType<
        DesktopBridge['subscribeSceneGenerationProgress']
      >,
    onSceneGenerationProgress: (listener) =>
      transport.subscribe(eventChannels.onSceneGenerationProgress, (value) =>
        listener(value as SceneGenerationRenderProgressEventVO)
      ),
    readScenePreviewAvailability: (request) =>
      transport.invoke(invokeChannels.readScenePreviewAvailability, request) as ReturnType<
        DesktopBridge['readScenePreviewAvailability']
      >,
    openScenePreview: (request) =>
      transport.invoke(invokeChannels.openScenePreview, request) as ReturnType<
        DesktopBridge['openScenePreview']
      >,
    preparePreviewStage: (request) =>
      transport.invoke(invokeChannels.preparePreviewStage, request) as ReturnType<
        DesktopBridge['preparePreviewStage']
      >,
    previewDialogueDraft: (request) =>
      transport.invoke(invokeChannels.previewDialogueDraft, request) as ReturnType<
        DesktopBridge['previewDialogueDraft']
      >,
    saveDialogueChanges: (request) =>
      transport.invoke(invokeChannels.saveDialogueChanges, request) as ReturnType<
        DesktopBridge['saveDialogueChanges']
      >,
    readDialogueSaveSettlement: (request) =>
      transport.invoke(invokeChannels.readDialogueSaveSettlement, request) as ReturnType<
        DesktopBridge['readDialogueSaveSettlement']
      >,
    selectPreviewDialogue: (request) =>
      transport.invoke(invokeChannels.selectPreviewDialogue, request) as ReturnType<
        DesktopBridge['selectPreviewDialogue']
      >,
    playPreviousDialogue: (request) =>
      transport.invoke(invokeChannels.playPreviousDialogue, request) as ReturnType<
        DesktopBridge['playPreviousDialogue']
      >,
    playNextDialogue: (request) =>
      transport.invoke(invokeChannels.playNextDialogue, request) as ReturnType<
        DesktopBridge['playNextDialogue']
      >,
    closeScenePreview: (request) =>
      transport.invoke(invokeChannels.closeScenePreview, request) as ReturnType<
        DesktopBridge['closeScenePreview']
      >,
    subscribeScenePreviewRuntime: (request) =>
      transport.invoke(invokeChannels.subscribeScenePreviewRuntime, request) as ReturnType<
        DesktopBridge['subscribeScenePreviewRuntime']
      >,
    onScenePreviewRuntime: (listener) =>
      transport.subscribe(eventChannels.onScenePreviewRuntime, listener),
    readCandidatePreview: (request) =>
      transport.invoke(invokeChannels.readCandidatePreview, request) as ReturnType<
        DesktopBridge['readCandidatePreview']
      >,
    readCandidatePreviewEvent: (request) =>
      transport.invoke(invokeChannels.readCandidatePreviewEvent, request) as ReturnType<
        DesktopBridge['readCandidatePreviewEvent']
      >,
    onCandidatePreviewReady: (listener) =>
      transport.subscribe(eventChannels.onCandidatePreviewReady, listener),
    onCandidatePreviewStageFailed: (listener) =>
      transport.subscribe(eventChannels.onCandidatePreviewStageFailed, listener),
    onCandidatePreviewInvalidated: (listener) =>
      transport.subscribe(eventChannels.onCandidatePreviewInvalidated, listener),
    exportSavedScene: (request) =>
      transport.invoke(invokeChannels.exportSavedScene, request) as ReturnType<
        DesktopBridge['exportSavedScene']
      >,
    readLatestPreviewSave: (request) =>
      transport.invoke(invokeChannels.readLatestPreviewSave, request) as ReturnType<
        DesktopBridge['readLatestPreviewSave']
      >,
    checkForUpdate: (request) =>
      transport.invoke(invokeChannels.checkForUpdate, request) as ReturnType<
        DesktopBridge['checkForUpdate']
      >,
    downloadUpdate: (request) =>
      transport.invoke(invokeChannels.downloadUpdate, request) as ReturnType<
        DesktopBridge['downloadUpdate']
      >,
    installUpdate: (request) =>
      transport.invoke(invokeChannels.installUpdate, request) as ReturnType<
        DesktopBridge['installUpdate']
      >,
    readUpdateStatus: (request) =>
      transport.invoke(invokeChannels.readUpdateStatus, request) as ReturnType<
        DesktopBridge['readUpdateStatus']
      >,
    onAppUpdateStatus: (listener) =>
      transport.subscribe(eventChannels.onAppUpdateStatus, (value) =>
        listener(value as UpdateStatusVO)
      ),
    openDirectory: (request) =>
      transport.invoke(invokeChannels.openDirectory, request) as ReturnType<
        DesktopBridge['openDirectory']
      >
  }
}
