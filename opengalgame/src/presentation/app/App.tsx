import type { ReactElement } from 'react'

import { ToastHost } from '../components/ToastHost'
import { HomePage } from '../pages/home/HomePage'
import { ProjectsPage } from '../pages/projects/ProjectsPage'
import { WorkbenchPage } from '../pages/workbench/WorkbenchPage'
import { useNavigationStore } from '../stores/navigation.store'
import { AppShell } from './AppShell'
import { PageTransition } from './PageTransition'
import type { ConnectionSettingsClient } from '@interfaces/client/ConnectionSettingsClient'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

interface AppProps {
  projectClient: ProjectClient
  connectionClient: ConnectionSettingsClient
  projectFilesClient: ProjectFilesClient
  sceneCanvasClient: SceneCanvasClient
  projectVersioningClient: ProjectVersioningClient
  sceneGenerationClient: SceneGenerationClient
  scenePreviewClient: ScenePreviewClient
  sceneExportClient: SceneExportClient
}

export function App({
  projectClient,
  connectionClient,
  projectFilesClient,
  sceneCanvasClient,
  projectVersioningClient,
  sceneGenerationClient,
  scenePreviewClient,
  sceneExportClient
}: AppProps): ReactElement {
  const page = useNavigationStore((state) => state.page)
  const openedProjectId = useNavigationStore((state) => state.openedProject?.id ?? 'workbench')
  return (
    <AppShell>
      <ToastHost />
      <PageTransition page={page}>
        {page === 'home' ? (
          <HomePage projectClient={projectClient} connectionClient={connectionClient} />
        ) : null}
        {page === 'projects' ? <ProjectsPage projectClient={projectClient} /> : null}
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
          />
        ) : null}
      </PageTransition>
    </AppShell>
  )
}
