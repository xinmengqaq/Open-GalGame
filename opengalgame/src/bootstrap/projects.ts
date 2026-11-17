import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { ProjectFileDialogGateway } from '@application/projects/ports/ProjectFileDialogGateway'
import type { ProjectWorkspaceService } from '@application/projects/services/ProjectWorkspaceService'
import { ManageProjectFiles } from '@application/project-files/services/impl/ManageProjectFiles'
import { ManageProjects } from '@application/projects/services/impl/ManageProjects'
import { CommitProject } from '@application/projects/services/impl/CommitProject'
import { ManageProjectWorkspace } from '@application/projects/services/impl/ManageProjectWorkspace'
import { RecoverProjectOperations } from '@application/projects/services/impl/RecoverProjectOperations'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { ProjectDomainService } from '@domain/projects/services/ProjectDomainService'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'
import { LocalProjectIdentityRepositoryImpl } from '@infrastructure/projects/LocalProjectIdentityRepositoryImpl'
import { LocalProjectListQueryGatewayImpl } from '@infrastructure/projects/LocalProjectListQueryGatewayImpl'
import { LocalProjectNotificationGatewayImpl } from '@infrastructure/projects/LocalProjectNotificationGatewayImpl'
import { LocalProjectOperationJournalGatewayImpl } from '@infrastructure/projects/LocalProjectOperationJournalGatewayImpl'
import { LocalProjectRegistrationGatewayImpl } from '@infrastructure/projects/LocalProjectRegistrationGatewayImpl'
import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { LocalDesktopFileOpenGatewayImpl } from '@infrastructure/project-files/LocalDesktopFileOpenGatewayImpl'
import { LocalProjectFileOperationGatewayImpl } from '@infrastructure/project-files/LocalProjectFileOperationGatewayImpl'
import { LocalProjectInputSourceReaderGatewayImpl } from '@infrastructure/project-files/LocalProjectInputSourceReaderGatewayImpl'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'
import { LocalSceneCanvasArrangementInspectionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementInspectionGatewayImpl'
import { EditSceneCanvas } from '@application/scene-canvas/services/impl/EditSceneCanvas'
import {
  LocalSceneCanvasArrangementPersistenceGatewayImpl,
  type SceneCanvasProjectLocation
} from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { LocalSceneCanvasWorkVersionGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasWorkVersionGatewayImpl'
import { CanvasArrangementMigration } from '@infrastructure/scene-canvas/migration/CanvasArrangementMigration'
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
  projects: ManageProjects
  projectFiles: ManageProjectFiles
  recovery: RecoverProjectOperations
  sceneCanvas: EditSceneCanvas
  versioning: ManageProjectVersioning
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
    new ManageProjectWorkspace({
      identity: new LocalProjectSceneIdentityGatewayImpl(userDirectory),
      seeds: new LocalProjectSceneSeedGatewayImpl(userDirectory),
      baseline: new LocalProjectBaselineGatewayImpl(versionGateways.transactions)
    })
  const commit = new CommitProject({
    domain,
    storage,
    registration,
    journal,
    logger,
    notifications,
    workspace
  })
  const listQuery = new LocalProjectListQueryGatewayImpl(userDirectory)
  const sources = new LocalProjectInputSourceReaderGatewayImpl()
  const versioning = new ManageProjectVersioning({
    ...versionGateways,
    nextId: randomUUID
  })
  const projectFiles = new ManageProjectFiles({
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
    createFileId: randomUUID
  })
  const projects = new ManageProjects({
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
    workspace,
    recoverProjectFiles: (projectId) => projectFiles.recoverProjectFiles(projectId)
  })
  const recovery = new RecoverProjectOperations({ journal, execution, commit, logger })
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
  const canvasMigration = new CanvasArrangementMigration({
    backupRoot: join(userDirectory, 'migrations', 'scene-canvas')
  })
  const canvasVersions = new LocalSceneCanvasWorkVersionGatewayImpl(versioning, locateCanvasProject)
  const sceneCanvas = new EditSceneCanvas({
    sources: projectFiles,
    persistence: new LocalSceneCanvasArrangementPersistenceGatewayImpl(
      locateCanvasProject,
      canvasMigration
    ),
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
