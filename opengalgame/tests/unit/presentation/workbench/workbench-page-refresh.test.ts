import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { ProjectInputCatalogVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { projectInputSourcesQueryKey } from '@presentation/features/input-catalog/useInputCatalog'
import { sourceFactsOf } from '@presentation/features/workbench-session/workbenchSessionSelectors'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import { refreshSources } from '@presentation/pages/workbench/useWorkbenchPage'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

const cachedCatalog: ProjectInputCatalogVO = {
  projectId: 'p-01',
  catalogVersion: 'v1',
  folders: [],
  sources: [
    {
      sourceId: 'doc-1',
      name: '角色设定',
      readable: true,
      parentFolderId: null,
      contentKind: 'text',
      textKind: 'document'
    }
  ]
}

function failedList(): AjaxResult<ProjectInputCatalogVO> {
  return { code: ErrorCodes.internalError, msg: '读取失败' }
}

function clientThatFailsList(): ProjectFilesClient {
  return {
    listProjectInputSources: async () => failedList()
  } as ProjectFilesClient
}

describe('再次进入工作台时刷新来源', () => {
  beforeEach(() => {
    vi.mocked(toast).mockReset()
    useWorkbenchSessionStore.getState().reset()
  })

  it('查询缓存里还有上次列表时，刷新失败会写回会话并保留目录状态，不再重复 Toast', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })
    queryClient.setQueryData(projectInputSourcesQueryKey('p-01'), cachedCatalog)
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(useWorkbenchSessionStore.getState().catalogStatus).toBe('loading')
    expect(useWorkbenchSessionStore.getState().sources).toEqual([])

    await refreshSources(clientThatFailsList(), queryClient, 'p-01')

    const state = useWorkbenchSessionStore.getState()
    expect(state.catalogStatus).toBe('ready')
    expect(state.sources).toEqual(cachedCatalog.sources)
    expect(state.catalogError?.msg).toBe('读取失败')
    expect(toast).not.toHaveBeenCalled()
    const facts = sourceFactsOf(state, 'doc-1')
    expect(facts.readable).toBe(true)
    expect(facts.disconnected).toBe(false)
  })

  it('没有缓存时刷新失败记成读取失败，不再重复 Toast', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })

    await refreshSources(clientThatFailsList(), queryClient, 'p-01')

    const state = useWorkbenchSessionStore.getState()
    expect(state.catalogStatus).toBe('failed')
    expect(state.sources).toEqual([])
    expect(toast).not.toHaveBeenCalled()
  })
})
