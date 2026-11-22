import type { DesktopBridge } from '@interfaces/client/DesktopBridge'

type LocalDesktopMethod = 'pathForDroppedFile'

type RemoteDesktopMethod = Exclude<keyof DesktopBridge, LocalDesktopMethod>

type DesktopMethodResult<K extends keyof DesktopBridge> = DesktopBridge[K] extends (
  ...args: never[]
) => infer Result
  ? Result
  : never

type DesktopInvokeMethod = {
  [K in RemoteDesktopMethod]: DesktopMethodResult<K> extends Promise<unknown> ? K : never
}[RemoteDesktopMethod]

type DesktopEventMethod = {
  [K in RemoteDesktopMethod]: DesktopMethodResult<K> extends () => void ? K : never
}[RemoteDesktopMethod]

export const desktopBridgeChannels = {
  invoke: {
    chooseSaveLocation: 'project:choose-save-location',
    clearSaveLocation: 'project:clear-save-location',
    createProject: 'project:create',
    importProject: 'project:import',
    listProjects: 'project:list',
    openProject: 'project:open',
    renameProject: 'project:rename',
    unregisterProject: 'project:unregister',
    ensureProjectWorkspace: 'project:ensure-workspace',
    inspectProjectWorkspace: 'project:inspect-workspace',
    inspectProjectFiles: 'project-files:inspect',
    listProjectInputSources: 'project-files:list-input-sources',
    readProjectInputSources: 'project-files:read-input-sources',
    readProjectMedia: 'project-files:read-media',
    readSceneCanvasArrangement: 'scene-canvas:read-arrangement',
    createSceneCanvasSourceCard: 'scene-canvas:create-source-card',
    createSceneCanvasPromptCard: 'scene-canvas:create-prompt-card',
    createSceneCanvasFieldCard: 'scene-canvas:create-field-card',
    editSceneCanvasCard: 'scene-canvas:edit-card',
    editSceneCanvasPromptBody: 'scene-canvas:edit-prompt-body',
    bindSceneCanvasFieldCardPreset: 'scene-canvas:bind-field-card-preset',
    editSceneCanvasMediaRole: 'scene-canvas:edit-media-role',
    copySceneCanvasCard: 'scene-canvas:copy-card',
    deleteSceneCanvasCard: 'scene-canvas:delete-card',
    connectSceneCanvasCards: 'scene-canvas:connect-cards',
    disconnectSceneCanvasCards: 'scene-canvas:disconnect-cards',
    editSceneCanvasRelationName: 'scene-canvas:edit-relation-name',
    attachSceneCanvasRelationRecord: 'scene-canvas:attach-relation-record',
    detachSceneCanvasRelationRecord: 'scene-canvas:detach-relation-record',
    saveSceneCanvasArrangement: 'scene-canvas:save-arrangement',
    chooseProjectFiles: 'project-files:choose-files',
    importProjectFiles: 'project-files:import',
    openProjectFile: 'project-files:open',
    renameProjectFile: 'project-files:rename',
    deleteProjectFile: 'project-files:delete',
    createProjectTextFile: 'project-files:create-text',
    updateProjectTextFileBody: 'project-files:update-text-body',
    createProjectFolder: 'project-files:create-folder',
    copyProjectFile: 'project-files:copy-file',
    moveProjectFile: 'project-files:move-file',
    copyProjectFolder: 'project-files:copy-folder',
    readProjectFileOperation: 'project-files:read-operation',
    recoverProjectFileOperations: 'project-files:recover-operations',
    renameProjectFolder: 'project-files:rename-folder',
    readProjectFolderDeletionPlan: 'project-files:folder-deletion-plan',
    deleteProjectFolder: 'project-files:delete-folder',
    getSettingsSummary: 'connection:get-summary',
    testConnection: 'connection:test',
    saveSettings: 'connection:save',
    listModels: 'connection:list-models',
    listVersionHistory: 'project-versioning:list-history',
    undoVersionHistoryEntry: 'project-versioning:undo-history-entry',
    clearVersionHistory: 'project-versioning:clear-history',
    startSceneGeneration: 'scene-generation:start',
    retrySceneGenerationRepair: 'scene-generation:retry-repair',
    getSceneGenerationStatus: 'scene-generation:status',
    getLatestSceneGeneration: 'scene-generation:latest',
    replySceneGeneration: 'scene-generation:reply',
    pauseSceneGeneration: 'scene-generation:pause',
    resumeSceneGeneration: 'scene-generation:resume',
    cancelSceneGeneration: 'scene-generation:cancel',
    listSceneGenerationHistory: 'scene-generation:list-history',
    readSceneGenerationCheckpoint: 'scene-generation:read-checkpoint',
    forkSceneGeneration: 'scene-generation:fork',
    openSceneGenerationPreview: 'scene-generation:open-preview',
    closeSceneGenerationPreview: 'scene-generation:close-preview',
    subscribeSceneGenerationProgress: 'scene-generation:progress',
    readScenePreviewAvailability: 'scene-preview:availability',
    openScenePreview: 'scene-preview:open',
    preparePreviewStage: 'scene-preview:prepare',
    previewDialogueDraft: 'scene-preview:draft',
    saveDialogueChanges: 'scene-preview:save',
    readDialogueSaveSettlement: 'scene-preview:settlement',
    selectPreviewDialogue: 'scene-preview:select-dialogue',
    playPreviousDialogue: 'scene-preview:previous-dialogue',
    playNextDialogue: 'scene-preview:next-dialogue',
    closeScenePreview: 'scene-preview:close',
    subscribeScenePreviewRuntime: 'scene-preview:subscribe',
    readCandidatePreview: 'scene-preview:read-candidate',
    readCandidatePreviewEvent: 'scene-preview:candidate-event',
    exportSavedScene: 'scene-export:export-saved-scene',
    readLatestSavedSceneVersion: 'scene-export:read-latest-saved-scene-version',
    chooseSceneExportDirectory: 'scene-export:choose-directory',
    checkForUpdate: 'app-update:check',
    downloadUpdate: 'app-update:download',
    installUpdate: 'app-update:install',
    readUpdateStatus: 'app-update:read-status',
    openDirectory: 'system:open-directory'
  } as const satisfies Record<DesktopInvokeMethod, string>,
  event: {
    onProjectProgress: 'project:progress',
    onSceneGenerationProgress: 'scene-generation:progress',
    onScenePreviewRuntime: 'scene-preview:runtime',
    onCandidatePreviewReady: 'scene-preview:ready',
    onCandidatePreviewStageFailed: 'scene-preview:stage-failed',
    onCandidatePreviewInvalidated: 'scene-preview:invalidated',
    onAppUpdateStatus: 'app-update:status'
  } as const satisfies Record<DesktopEventMethod, string>
} as const

export type DesktopBridgeInvokeChannel =
  (typeof desktopBridgeChannels.invoke)[keyof typeof desktopBridgeChannels.invoke]

export type DesktopBridgeEventChannel =
  (typeof desktopBridgeChannels.event)[keyof typeof desktopBridgeChannels.event]
