import { app, dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { createProjectServices } from './projects'
import { createSceneGeneration } from './sceneGeneration'
import { diagnosticReference } from './sceneGenerationFailureFacts'
import { createScenePreview } from './scenePreview'
import { createSceneExport } from './sceneExport'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { errorFacts } from '@common/errors/errorFacts'
import { ManageAppUpdate } from '@application/app-update/services/impl/ManageAppUpdate'
import { didInstallAttemptFail } from '@domain/app-update/models/InstallAttempt'
import { ElectronUpdaterGatewayImpl } from '@infrastructure/app-update/ElectronUpdaterGatewayImpl'
import { UserDataInstallAttemptGatewayImpl } from '@infrastructure/app-update/UserDataInstallAttemptGatewayImpl'
import { AppUpdateController } from '@interfaces/app-update/ipc/AppUpdateController'
import { registerAppUpdateIpc } from '@interfaces/app-update/ipc/registerAppUpdateIpc'
import {
  diagnosticFactPayload,
  FAILURE_CAUSE_NAME,
  recordedFailureOf
} from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { assertUserDirectory } from './userDirectory'
import { ManageConnectionSettings } from '@application/connections/services/impl/ManageConnectionSettings'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { EncryptedConnectionSettingsGatewayImpl } from '@infrastructure/connections/EncryptedConnectionSettingsGatewayImpl'
import { PinoLoggerGatewayImpl } from '@infrastructure/logging/PinoLoggerGatewayImpl'
import { GitCandidatePreviewGatewayImpl } from '@infrastructure/scene-generation/preview/GitCandidatePreviewGatewayImpl'
import { RegisteredSceneProductionContext } from '@infrastructure/scene-generation/inputs/RegisteredSceneProductionContext'
import { LangChainModelConnectionGatewayImpl } from '@infrastructure/connections/LangChainModelConnectionGatewayImpl'
import { FileConfigurationGatewayImpl } from '@infrastructure/config/FileConfigurationGatewayImpl'
import { ElectronProjectFileChooser } from '@infrastructure/project-files/ElectronProjectFileChooser'
import { ElectronProjectFileDialogGatewayImpl } from '@infrastructure/projects/ElectronProjectFileDialogGatewayImpl'
import { registerProcessExceptionHandler } from '@infrastructure/runtime/ProcessExceptionHandler'
import { ElectronSecretCipherImpl } from '@infrastructure/security/ElectronSecretCipherImpl'
import { ConnectionSettingsController } from '@interfaces/ipc/controllers/ConnectionSettingsController'
import { ProjectController } from '@interfaces/ipc/controllers/ProjectController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { registerHomeIpc } from '@interfaces/ipc/registerHomeIpc'
import { ProjectFilesController } from '@interfaces/project-files/ipc/ProjectFilesController'
import { registerProjectFilesIpc } from '@interfaces/project-files/ipc/registerProjectFilesIpc'
import { ProjectVersioningController } from '@interfaces/project-versioning/ipc/ProjectVersioningController'
import { registerProjectVersioningIpc } from '@interfaces/project-versioning/ipc/registerProjectVersioningIpc'
import { SceneCanvasController } from '@interfaces/scene-canvas/ipc/SceneCanvasController'
import { registerSceneCanvasIpc } from '@interfaces/scene-canvas/ipc/registerSceneCanvasIpc'
import { SceneGenerationController } from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { registerSceneGenerationIpc } from '@interfaces/scene-generation/ipc/registerSceneGenerationIpc'
import { ScenePreviewController } from '@interfaces/scene-preview/ipc/ScenePreviewController'
import { registerScenePreviewIpc } from '@interfaces/scene-preview/ipc/registerScenePreviewIpc'
import { SceneExportController } from '@interfaces/scene-export/ipc/SceneExportController'
import { registerSceneExportIpc } from '@interfaces/scene-export/ipc/registerSceneExportIpc'
import { OpenDirectory } from '@application/system-path/services/impl/OpenDirectory'
import { LocalDirectoryOpenGateway } from '@infrastructure/system-path/LocalDirectoryOpenGateway'
import { SystemPathController } from '@interfaces/system-path/ipc/SystemPathController'
import { registerSystemPathIpc } from '@interfaces/system-path/ipc/registerSystemPathIpc'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'

export async function createHomeBackend(options: {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
  userDirectory?: string
}): Promise<() => Promise<void>> {
  const userDirectory = assertUserDirectory(
    options.userDirectory ?? join(app.getPath('home'), '.opengalgame')
  )
  const config = new FileConfigurationGatewayImpl(
    join(userDirectory, 'runtime-config.json')
  ).getSnapshot()
  const logger = new PinoLoggerGatewayImpl(join(userDirectory, 'logs'), config)
  const detachProcess = registerProcessExceptionHandler(logger, () => app.exit(1))
  const projects = createProjectServices({
    userDirectory,
    dialogs: new ElectronProjectFileDialogGatewayImpl(options.getWindow, userDirectory),
    logger
  })
  const settingsGateway = new EncryptedConnectionSettingsGatewayImpl(
    userDirectory,
    new ElectronSecretCipherImpl()
  )
  const connections = new ManageConnectionSettings({
    settings: settingsGateway,
    model: new LangChainModelConnectionGatewayImpl(config.requestTimeoutMs)
  })
  const require = createRequire(import.meta.url)
  const repositoryRoot = resolve(dirname(require.resolve('webgal-parser/package.json')), '../../..')
  const promptRoot = app.isPackaged
    ? join(app.getAppPath(), 'resources', 'ai', 'prompts')
    : join(repositoryRoot, 'opengalgame/resources/ai/prompts')
  const preview = new GitCandidatePreviewGatewayImpl(
    new AiProjectFileSystemImpl(userDirectory),
    join(userDirectory, 'ai'),
    Date.now,
    undefined,
    undefined,
    { logger }
  )
  const generation = await createSceneGeneration({
    userStateRoot: userDirectory,
    promptRoot,
    loadSettings: () => settingsGateway.loadSettings(),
    dispatch: (job, identity) => {
      void job().catch((error: unknown) => {
        const facts = errorFacts(error)
        const category = error instanceof AppException ? error.diagnosticCategory : undefined
        const causeNames = facts.causeNames.filter((name) => FAILURE_CAUSE_NAME.test(name))
        const payload = diagnosticFactPayload({ ...facts, causeNames }, category)
        const diagnosticRef = payload ? diagnosticReference(payload) : undefined
        const recorded = recordedFailureOf(error)
        logger.error('场景生成后台任务失败', {
          operationId: identity.operationId,
          projectId: identity.projectId,
          errorCode: error instanceof AppException ? error.code : ErrorCodes.internalError,
          ...(facts.errorName ? { errorName: facts.errorName } : {}),
          ...(causeNames.length > 0 ? { causeNames: causeNames.join(',') } : {}),
          ...(facts.causeCodes.length > 0 ? { causeCodes: facts.causeCodes.join(',') } : {}),
          ...(facts.statuses.length > 0 ? { statuses: facts.statuses.join(',') } : {}),
          ...(diagnosticRef ? { diagnosticRef } : {}),
          ...(recorded?.diagnosticRef && recorded.diagnosticRef !== diagnosticRef
            ? { recordedDiagnosticRef: recorded.diagnosticRef }
            : {}),
          ...(category ? { category } : {}),
          ...(recorded?.category && recorded.category !== category
            ? { recordedCategory: recorded.category }
            : {})
        })
      })
    },
    publishProgress: () => undefined,
    versioning: projects.versioning,
    projects: projects.projects,
    render: {
      canvasVersions: projects.canvasVersions,
      saveArrangement: (request) => projects.sceneCanvas.saveSceneCanvasArrangement(request),
      readCurrentArrangement: (request) => projects.sceneCanvas.readSceneCanvasArrangement(request),
      production: new RegisteredSceneProductionContext(userDirectory),
      preview
    }
  })
  const exceptions = new IpcExceptionHandler(logger, new IpcErrorMapper())
  const appUpdateRelease = new ElectronUpdaterGatewayImpl(logger)
  const appUpdateInstallAttempts = new UserDataInstallAttemptGatewayImpl(
    join(app.getPath('userData'), 'app-update', 'install-attempt.json')
  )
  let previousInstallFailed = false
  try {
    const attempt = await appUpdateInstallAttempts.read()
    if (attempt !== null) {
      try {
        previousInstallFailed = didInstallAttemptFail(app.getVersion(), attempt)
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined
        logger.warn('更新安装记录无法判定', {
          ...(errorName === undefined ? {} : { errorName })
        })
      }
      try {
        await appUpdateInstallAttempts.clear()
      } catch (error) {
        const errorName = error instanceof Error ? error.name : undefined
        logger.warn('清理更新安装记录失败', {
          ...(errorName === undefined ? {} : { errorName })
        })
      }
    }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : undefined
    logger.warn('读取更新安装记录失败', {
      ...(errorName === undefined ? {} : { errorName })
    })
    try {
      await appUpdateInstallAttempts.clear()
    } catch (clearError) {
      const errorName = clearError instanceof Error ? clearError.name : undefined
      logger.warn('清理更新安装记录失败', {
        ...(errorName === undefined ? {} : { errorName })
      })
    }
  }
  const appUpdate = new ManageAppUpdate({
    release: appUpdateRelease,
    installAttempts: appUpdateInstallAttempts,
    logger,
    now: Date.now,
    previousInstallFailed
  })
  const detachAppUpdateIpc = registerAppUpdateIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    controller: new AppUpdateController(appUpdate, exceptions),
    subscribe: (listener) => appUpdate.subscribe(listener)
  })
  const scenePreviewHost = new WebgalRuntimeHostImpl({
    engineRoot: dirname(require.resolve('webgal-engine/package.json')),
    engineExtension: { autoStart: true }
  })
  const scenePreview = createScenePreview({
    userDirectory,
    versioning: projects.versioning,
    sessionLookup: preview,
    host: scenePreviewHost
  })
  const detachScenePreviewIpc = registerScenePreviewIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    scenePreview: new ScenePreviewController(
      scenePreview.currentScenePreview,
      scenePreview.candidatePreview,
      exceptions,
      preview
    )
  })
  const sceneExport = createSceneExport({
    userDirectory,
    logger,
    versioning: projects.versioning,
    sources: scenePreview.currentScene.sources,
    chooseDirectory: () => chooseExportDirectory(options.getWindow),
    protectedRoots: [app.getPath('userData'), process.resourcesPath, app.getAppPath()]
  })
  const detachSceneExportIpc = registerSceneExportIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    sceneExport: new SceneExportController(
      sceneExport.exportSavedScene,
      sceneExport.latestSavedSceneVersion,
      sceneExport.chooseDestination,
      exceptions
    )
  })
  const detachSystemPathIpc = registerSystemPathIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    systemPath: new SystemPathController(
      new OpenDirectory({
        directories: new LocalDirectoryOpenGateway((absolutePath) => shell.openPath(absolutePath))
      }),
      exceptions
    )
  })

  if (
    !generation.launch ||
    !generation.renderQuery ||
    !generation.control ||
    !generation.candidatePreview
  ) {
    throw new AppException({ code: ErrorCodes.invalidConfig, msg: '场景生成应用服务未装配' })
  }
  const detachSceneGenerationIpc = registerSceneGenerationIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    sceneGeneration: new SceneGenerationController(
      {
        launch: generation.launch,
        renderQuery: generation.renderQuery,
        control: generation.control,
        history: generation.history,
        preview: generation.candidatePreview,
        generation: generation.generation
      },
      exceptions
    )
  })
  await projects.recovery.recoverIncompleteOperations()
  const detachSceneCanvasIpc = registerSceneCanvasIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    sceneCanvas: new SceneCanvasController(projects.sceneCanvas, exceptions)
  })
  const detachProjectFilesIpc = registerProjectFilesIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    projectFiles: new ProjectFilesController(
      projects.projectFiles,
      exceptions,
      new ElectronProjectFileChooser(options.getWindow)
    )
  })
  const detachVersioningIpc = registerProjectVersioningIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    projectVersioning: new ProjectVersioningController(projects.versioning, exceptions)
  })
  const projectController = new ProjectController(
    projects.projects,
    exceptions,
    async (projectId) => {
      try {
        const result = await generation.recovery.recoverCancelledProject(projectId)
        if (result.failed > 0)
          logger.warn('场景生成取消清理未完成', {
            projectId,
            stage: `cancelCleanupFailed:${result.failed}`
          })
      } catch (error) {
        // 打开工程已经成功；清理失败保持可重试，不用打开失败掩盖真实状态。
        logger.warn('场景生成取消清理失败', {
          projectId,
          errorCode: error instanceof AppException ? error.code : ErrorCodes.internalError
        })
      }
    }
  )
  const detachIpc = registerHomeIpc({
    getWindow: options.getWindow,
    rendererUrl: options.rendererUrl,
    projects: projectController,
    connections: new ConnectionSettingsController(connections, exceptions)
  })
  return async () => {
    detachAppUpdateIpc()
    detachSceneExportIpc()
    detachSystemPathIpc()
    detachScenePreviewIpc()
    detachSceneGenerationIpc()
    detachSceneCanvasIpc()
    detachProjectFilesIpc()
    detachVersioningIpc()
    detachIpc()
    detachProcess()
    appUpdateRelease.dispose()
    scenePreview.bridge.dispose()
    await scenePreviewHost.dispose()
    await generation.close()
    await projects.close()
    await logger.close()
  }
}

/**
 * 导出父目录只由主进程选择；用户取消返回 null，不创建目录、不保存选择。
 * 选择器允许新建文件夹，但返回的只是父目录，产物子目录由打包器创建。
 */
async function chooseExportDirectory(
  getWindow: () => BrowserWindow | null
): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '选择导出位置',
    buttonLabel: '选择此文件夹',
    properties: ['openDirectory', 'createDirectory']
  }
  const window = getWindow()
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}
