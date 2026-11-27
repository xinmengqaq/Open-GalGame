import { useCallback, useState, type ReactElement } from 'react'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ToastHost } from '../components/ToastHost'
import { AppUpdateErrorDialog } from '../features/app-update/AppSettingsDialog'
import { useAppUpdate } from '../features/app-update/useAppUpdate'
import { useConnectionSettings } from '../features/connection-settings/useConnectionSettings'
import { SettingsCenter } from '../features/settings/SettingsCenter'
import { useAppearanceSettings } from '../features/settings/appearance/useAppearanceSettings'
import type { SettingsSectionId } from '../features/settings/settingsNavigation'
import { BeginnerGuideHost } from '../features/beginner-guide/BeginnerGuideHost'
import { guideMediaImportActionOf } from '../features/beginner-guide/guideMedia'
import type { UseInputCatalog } from '../features/input-catalog/inputCatalog.types'
import { HomePage } from '../pages/home/HomePage'
import { ProjectsPage } from '../pages/projects/ProjectsPage'
import { WorkbenchPage } from '../pages/workbench/WorkbenchPage'
import { useNavigationStore } from '../stores/navigation.store'
import { AppShell } from './AppShell'
import { createCreatorActionObservation } from './observeCreatorActions'
import { PageTransition } from './PageTransition'
import type { AppUpdateClient } from '@interfaces/app-update/client/AppUpdateClient'
import type { AppearanceSettingsClient } from '@interfaces/settings/appearance/client/AppearanceSettingsClient'
import type { ConnectionSettingsClient } from '@interfaces/settings/connections/client/ConnectionSettingsClient'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import type { SystemPathClient } from '@interfaces/system-path/client/SystemPathClient'

const creatorActions = createCreatorActionObservation()
const guideObservationSource = creatorActions.source

/** 文件区挂载时把真实 importFiles 适配成教程选材动作；卸载即解绑。 */
const bindGuideImport = (importFiles: UseInputCatalog['importFiles'] | null): void => {
  creatorActions.bindMediaImport(importFiles ? guideMediaImportActionOf(importFiles) : null)
}

interface AppProps {
  projectClient: ProjectClient
  appearanceClient: AppearanceSettingsClient
  connectionClient: ConnectionSettingsClient
  appUpdateClient: AppUpdateClient
  projectFilesClient: ProjectFilesClient
  sceneCanvasClient: SceneCanvasClient
  projectVersioningClient: ProjectVersioningClient
  sceneGenerationClient: SceneGenerationClient
  scenePreviewClient: ScenePreviewClient
  sceneExportClient: SceneExportClient
  systemPathClient: SystemPathClient
}

export function App({
  projectClient,
  appearanceClient,
  connectionClient,
  appUpdateClient,
  projectFilesClient,
  sceneCanvasClient,
  projectVersioningClient,
  sceneGenerationClient,
  scenePreviewClient,
  sceneExportClient,
  systemPathClient
}: AppProps): ReactElement {
  const page = useNavigationStore((state) => state.page)
  const openedProjectId = useNavigationStore((state) => state.openedProject?.id ?? 'workbench')
  const appUpdate = useAppUpdate(appUpdateClient)
  const appearance = useAppearanceSettings(appearanceClient)
  const connection = useConnectionSettings(connectionClient, {
    onConnectionTested: creatorActions.onConnectionTested,
    onConnectionTestFailed: creatorActions.onConnectionTestFailed,
    onConnectionChanged: creatorActions.onConnectionChanged,
    onConnectionSaved: creatorActions.onConnectionSaved
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRequestedSection, setSettingsRequestedSection] = useState<
    SettingsSectionId | undefined
  >(undefined)
  const [settingsModelConfigured, setSettingsModelConfigured] = useState<boolean | undefined>(
    undefined
  )
  const [guideRestart, setGuideRestart] = useState(0)
  const readModelConfigured = useCallback(async (): Promise<boolean> => {
    try {
      const result = await connectionClient.getSettingsSummary()
      const summary = result.data
      return (
        result.code === ErrorCodes.success &&
        summary !== null &&
        summary !== undefined &&
        summary.model.trim() !== ''
      )
    } catch {
      return false
    }
  }, [connectionClient])
  const openSettingsCenter = useCallback(
    (section?: SettingsSectionId): void => {
      setSettingsRequestedSection(section)
      if (section) {
        setSettingsModelConfigured(undefined)
        setSettingsOpen(true)
        return
      }
      void readModelConfigured().then((configured) => {
        setSettingsModelConfigured(configured)
        setSettingsOpen(true)
      })
    },
    [readModelConfigured]
  )
  return (
    <AppShell>
      <ToastHost />
      {/* 教程唯一挂载点：App 是真实组合根，AppShell 仅为 Stage 包装。 */}
      <BeginnerGuideHost
        restartRequest={guideRestart}
        page={page}
        observationSource={guideObservationSource}
        importMedia={creatorActions.mediaImport}
        readModelConfigured={readModelConfigured}
      />
      <PageTransition page={page}>
        {page === 'home' ? (
          <HomePage
            projectClient={projectClient}
            appUpdate={appUpdate}
            onOpenSettings={openSettingsCenter}
            onProjectCreated={creatorActions.onProjectCreated}
          />
        ) : null}
        {page === 'projects' ? (
          <ProjectsPage
            projectClient={projectClient}
            onProjectCreated={creatorActions.onProjectCreated}
          />
        ) : null}
        {page === 'workbench' ? (
          <WorkbenchPage
            key={openedProjectId}
            projectClient={projectClient}
            projectFilesClient={projectFilesClient}
            sceneCanvasClient={sceneCanvasClient}
            projectVersioningClient={projectVersioningClient}
            sceneGenerationClient={sceneGenerationClient}
            scenePreviewClient={scenePreviewClient}
            sceneExportClient={sceneExportClient}
            systemPathClient={systemPathClient}
            observers={creatorActions.workbench}
            onImportFilesChange={bindGuideImport}
          />
        ) : null}
      </PageTransition>
      <SettingsCenter
        open={settingsOpen}
        requestedSection={settingsRequestedSection}
        modelConfigured={settingsModelConfigured}
        appearance={appearance}
        connection={connection}
        appUpdate={appUpdate}
        onClose={() => setSettingsOpen(false)}
        onRestartGuide={() => setGuideRestart((n) => n + 1)}
      />
      <AppUpdateErrorDialog flow={appUpdate} />
    </AppShell>
  )
}
