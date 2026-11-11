import { useGSAP } from '@gsap/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import gsap from 'gsap'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { createBrowserDesktopBridge } from './browser/BrowserDesktopBridge'
import { ConnectionSettingsClientImpl } from '@interfaces/client/ConnectionSettingsClientImpl'
import { ProjectClientImpl } from '@interfaces/client/ProjectClientImpl'
import { ProjectFilesClientImpl } from '@interfaces/project-files/client/ProjectFilesClientImpl'
import { ProjectVersioningClientImpl } from '@interfaces/project-versioning/client/ProjectVersioningClientImpl'
import { SceneCanvasClientImpl } from '@interfaces/scene-canvas/client/SceneCanvasClientImpl'
import { SceneExportClientImpl } from '@interfaces/scene-export/client/SceneExportClientImpl'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import { ScenePreviewClientImpl } from '@interfaces/scene-preview/client/ScenePreviewClientImpl'
import { App } from '@presentation/app/App'

import '@presentation/effects/base.css'
import '@presentation/effects/ai-elements.css'

gsap.registerPlugin(useGSAP)

// 数据只由本机的具名操作改动，靠变更显式失效；IPC 失败按提示由用户重试，不自动重试。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity }
  }
})

/** 装配表现层。有 preload 用桌面桥，否则用浏览器验证桥。 */
function startRenderer(): void {
  const rootElement = document.getElementById('root')
  if (rootElement === null) {
    throw new Error('root element is missing')
  }
  const bridge = window.opengalgame ?? createBrowserDesktopBridge()
  const projectClient = new ProjectClientImpl(bridge)
  const connectionClient = new ConnectionSettingsClientImpl(bridge)
  const projectFilesClient = new ProjectFilesClientImpl(bridge)
  const sceneCanvasClient = new SceneCanvasClientImpl(bridge)
  const projectVersioningClient = new ProjectVersioningClientImpl(bridge)
  const sceneGenerationClient = new SceneGenerationClientImpl(bridge)
  const scenePreviewClient = new ScenePreviewClientImpl(bridge)
  const sceneExportClient = new SceneExportClientImpl(bridge)
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App
          projectClient={projectClient}
          connectionClient={connectionClient}
          projectFilesClient={projectFilesClient}
          sceneCanvasClient={sceneCanvasClient}
          projectVersioningClient={projectVersioningClient}
          sceneGenerationClient={sceneGenerationClient}
          scenePreviewClient={scenePreviewClient}
          sceneExportClient={sceneExportClient}
        />
      </QueryClientProvider>
    </StrictMode>
  )
}

startRenderer()
