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

export interface DesktopTransport {
  invoke(channel: DesktopBridgeInvokeChannel, input?: unknown): Promise<unknown>
  subscribe(channel: DesktopBridgeEventChannel, listener: (value: unknown) => void): () => void
}

const { event: eventChannels, invoke: invokeChannels } = desktopBridgeChannels

export function createDesktopBridge(transport: DesktopTransport): DesktopBridge {
  return {
    chooseSaveLocation: () =>
      transport.invoke(invokeChannels.chooseSaveLocation) as ReturnType<
        DesktopBridge['chooseSaveLocation']
      >,
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
    ensureProjectWorkspace: (request) =>
      transport.invoke(invokeChannels.ensureProjectWorkspace, request) as ReturnType<
        DesktopBridge['ensureProjectWorkspace']
      >,
    inspectProjectWorkspace: (request) =>
      transport.invoke(invokeChannels.inspectProjectWorkspace, request) as ReturnType<
        DesktopBridge['inspectProjectWorkspace']
      >,
    inspectProjectFiles: (request) =>
      transport.invoke(invokeChannels.inspectProjectFiles, request) as ReturnType<
        DesktopBridge['inspectProjectFiles']
      >,
    listProjectInputSources: (request) =>
      transport.invoke(invokeChannels.listProjectInputSources, request) as ReturnType<
        DesktopBridge['listProjectInputSources']
      >,
    readProjectInputSources: (request) =>
      transport.invoke(invokeChannels.readProjectInputSources, request) as ReturnType<
        DesktopBridge['readProjectInputSources']
      >,
    readProjectMedia: (request) =>
      transport.invoke(invokeChannels.readProjectMedia, request) as ReturnType<
        DesktopBridge['readProjectMedia']
      >,
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
    openProjectFile: (request) =>
      transport.invoke(invokeChannels.openProjectFile, request) as ReturnType<
        DesktopBridge['openProjectFile']
      >,
    renameProjectFile: (request) =>
      transport.invoke(invokeChannels.renameProjectFile, request) as ReturnType<
        DesktopBridge['renameProjectFile']
      >,
    deleteProjectFile: (request) =>
      transport.invoke(invokeChannels.deleteProjectFile, request) as ReturnType<
        DesktopBridge['deleteProjectFile']
      >,
    createProjectTextFile: (request) =>
      transport.invoke(invokeChannels.createProjectTextFile, request) as ReturnType<
        DesktopBridge['createProjectTextFile']
      >,
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
    forkSceneGeneration: (request) =>
      transport.invoke(invokeChannels.forkSceneGeneration, request) as ReturnType<
        DesktopBridge['forkSceneGeneration']
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
    readLatestSavedSceneVersion: (request) =>
      transport.invoke(invokeChannels.readLatestSavedSceneVersion, request) as ReturnType<
        DesktopBridge['readLatestSavedSceneVersion']
      >,
    chooseSceneExportDirectory: (request) =>
      transport.invoke(invokeChannels.chooseSceneExportDirectory, request) as ReturnType<
        DesktopBridge['chooseSceneExportDirectory']
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
