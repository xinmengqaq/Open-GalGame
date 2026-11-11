import { randomUUID } from 'node:crypto'

import type { ProjectFileDialogGateway } from '@application/projects/ports/ProjectFileDialogGateway'
import type { ProjectWorkspaceService } from '@application/projects/services/ProjectWorkspaceService'
import { ProjectFilesApplicationServiceImpl } from '@application/project-files/services/impl/ProjectFilesApplicationServiceImpl'
import { ProjectApplicationServiceImpl } from '@application/projects/services/impl/ProjectApplicationServiceImpl'
import { ProjectCommitServiceImpl } from '@application/projects/services/impl/ProjectCommitServiceImpl'
import { ProjectWorkspaceServiceImpl } from '@application/projects/services/impl/ProjectWorkspaceServiceImpl'
import { ProjectRecoveryApplicationServiceImpl } from '@application/projects/services/impl/ProjectRecoveryApplicationServiceImpl'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { ProjectDomainService } from '@domain/projects/services/ProjectDomainService'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'
import { LocalProjectIdentityRepositoryImpl } from '@infrastructure/projects/LocalProjectIdentityRepositoryImpl'
import { LocalProjectListQueryGatewayImpl } from '@infrastructure/projects/LocalProjectListQueryGatewayImpl'
import { LocalProjectNotificationGatewayImpl } from '@infrastructure/projects/LocalProjectNotificationGatewayImpl'
import { LocalProjectOperationJournalGatewayImpl } from '@infrastructure/projects/LocalProjectOperationJournalGatewayImpl'
import { LocalProjectRegistrationGatewayImpl } from '@infrastructure/projects/LocalProjectRegistrationGatewayImpl'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { LocalDesktopFileOpenGatewayImpl } from '@infrastructure/project-files/LocalDesktopFileOpenGatewayImpl'
import { LocalProjectFileOperationGatewayImpl } from '@infrastructure/project-files/LocalProjectFileOperationGatewayImpl'
import { LocalProjectInputSourceReaderGatewayImpl } from '@infrastructure/project-files/LocalProjectInputSourceReaderGatewayImpl'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'
import { LocalSceneCanvasArrangementInspectionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementInspectionGatewayImpl'
import { SceneCanvasApplicationServiceImpl } from '@application/scene-canvas/services/impl/SceneCanvasApplicationServiceImpl'
import {
  LocalSceneCanvasArrangementPersistenceGatewayImpl,
  type SceneCanvasProjectLocation
} from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { LocalSceneCanvasWorkVersionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasWorkVersionGatewayImpl'
import { Project } from '@domain/projects/models/Project'
import { LocalProjectStorageGatewayImpl } from '@infrastructure/projects/LocalProjectStorageGatewayImpl'
import { LocalProjectBaselineGatewayImpl } from '@infrastructure/projects/LocalProjectBaselineGatewayImpl'
import { LocalProjectSceneIdentityGatewayImpl } from '@infrastructure/projects/LocalProjectSceneIdentityGatewayImpl'
import { LocalProjectSceneSeedGatewayImpl } from '@infrastructure/projects/LocalProjectSceneSeedGatewayImpl'
import { SerialProjectExecutionGatewayImpl } from '@infrastructure/projects/SerialProjectExecutionGatewayImpl'

export function createProjectServices(options: {
  userDirectory: string
  dialogs: ProjectFileDialogGateway
  logger: LoggerGateway
  openPath?: (absolutePath: string) => Promise<string>
  workspace?: ProjectWorkspaceService
}): {
  projects: ProjectApplicationServiceImpl
  projectFiles: ProjectFilesApplicationServiceImpl
  recovery: ProjectRecoveryApplicationServiceImpl
  sceneCanvas: SceneCanvasApplicationServiceImpl
  versioning: ProjectVersioningApplicationServiceImpl
  canvasVersions: LocalSceneCanvasWorkVersionGatewayImpl
  journal: LocalProjectOperationJournalGatewayImpl
  registration: LocalProjectRegistrationGatewayImpl
  storage: LocalProjectStorageGatewayImpl
  close: () => Promise<void>
} {
  const { userDirectory, logger } = options
  const journal = new LocalProjectOperationJournalGatewayImpl(userDirectory)
  const registration = new LocalProjectRegistrationGatewayImpl(userDirectory)
  const storage = new LocalProjectStorageGatewayImpl()
  const execution = new SerialProjectExecutionGatewayImpl()
  const notifications = new LocalProjectNotificationGatewayImpl(logger)
  const domain: ProjectDomainService = new ProjectDomainServiceImpl()
  const versionGateways = createProjectVersioningGateways(userDirectory)
  const workspace =
    options.workspace ??
    new ProjectWorkspaceServiceImpl({
      identity: new LocalProjectSceneIdentityGatewayImpl(userDirectory),
      seeds: new LocalProjectSceneSeedGatewayImpl(userDirectory),
      baseline: new LocalProjectBaselineGatewayImpl(versionGateways.transactions)
    })
  const commit = new ProjectCommitServiceImpl({
    domain,
    storage,
    registration,
    journal,
    logger,
    notifications,
    workspace
  })
  const listQuery = new LocalProjectListQueryGatewayImpl(userDirectory)
  const projects = new ProjectApplicationServiceImpl({
    dialogs: options.dialogs,
    storage,
    journal,
    execution,
    identities: new LocalProjectIdentityRepositoryImpl(userDirectory),
    domain,
    commit,
    nextId: randomUUID,
    notifications,
    listQuery,
    registration,
    logger,
    workspace
  })
  const sources = new LocalProjectInputSourceReaderGatewayImpl()
  const versioning = new ProjectVersioningApplicationServiceImpl({
    ...versionGateways,
    nextId: randomUUID
  })
  const projectFiles = new ProjectFilesApplicationServiceImpl({
    listQuery,
    domain,
    storage,
    sources,
    arrangements: new LocalSceneCanvasArrangementInspectionGatewayImpl(),
    files: new LocalProjectFileOperationGatewayImpl(),
    versions: new LocalProjectWorkVersionGatewayImpl(versioning, (project) =>
      sources.readProjectInputCatalog(project).then((catalog) => catalog.catalogVersion)
    ),
    desktopOpen: new LocalDesktopFileOpenGatewayImpl(options.openPath),
    createSourceId: randomUUID,
    createFolderId: randomUUID,
    createFileId: randomUUID,
    createOperationId: randomUUID
  })
  const recovery = new ProjectRecoveryApplicationServiceImpl({ journal, execution, commit, logger })
  const locateCanvasProject = async (projectId: string): Promise<SceneCanvasProjectLocation> => {
    const registration = await listQuery.findRegistration(projectId)
    domain.requireRegistered(registration)
    const inspection = await storage.inspect({ directory: registration.directory })
    const project = Project.restoreRegisteredProject({
      workspace: inspection,
      identity: { id: registration.id }
    })
    return { projectId: project.id, directory: registration.directory }
  }
  const canvasVersions = new LocalSceneCanvasWorkVersionGatewayImpl(versioning, locateCanvasProject)
  const sceneCanvas = new SceneCanvasApplicationServiceImpl({
    sources: projectFiles,
    persistence: new LocalSceneCanvasArrangementPersistenceGatewayImpl(locateCanvasProject),
    versions: canvasVersions,
    workspace: projects,
    nextId: randomUUID
  })
  return {
    projects,
    projectFiles,
    recovery,
    sceneCanvas,
    versioning,
    canvasVersions,
    journal,
    registration,
    storage,
    close: () => execution.close()
  }
}
