import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import {
  reloadCatalog,
  projectInputSourcesQueryKey
} from '@presentation/features/input-catalog/catalogSession'
import { workbenchStateOf } from '@presentation/features/workbench-session/workbenchState'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

const source = {
  sourceId: 'doc-1',
  name: '角色.md',
  readable: true,
  parentFolderId: null,
  contentKind: 'text' as const,
  textKind: 'document' as const
}

describe('目录刷新', () => {
  afterEach(() => {
    useWorkbenchSessionStore.getState().reset()
    vi.mocked(toast).mockReset()
  })

  it('缓存回退后仍保留目录失败，不把上次结果显示为就绪', async () => {
    const store = useWorkbenchSessionStore.getState()
    store.startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    store.setArrangement({
      projectId: 'p-01',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [],
      relations: []
    })
    store.setCatalog([source])
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })
    queryClient.setQueryData(projectInputSourcesQueryKey('p-01'), {
      projectId: 'p-01',
      catalogVersion: 'v1',
      folders: [],
      sources: [source]
    })
    const client = {
      listProjectInputSources: async () => ({
        code: 500,
        msg: '目录暂时读不到',
        data: null
      })
    } as unknown as ProjectFilesClient

    await reloadCatalog(client, queryClient, 'p-01')

    const state = useWorkbenchSessionStore.getState()
    const view = workbenchStateOf({
      catalogStatus: state.catalogStatus,
      catalogError: state.catalogError,
      arrangementStatus: state.arrangementStatus,
      arrangementError: state.arrangementError
    })
    expect(state.sources.map((item) => item.name)).toEqual(['角色.md'])
    expect(state.catalogError?.code).toBe(500)
    expect(view.kind).toBe('read-failed')
    expect(view.scope).toBe('catalog')
    expect(view.title).toBe('来源列表读取失败')
    expect(toast).not.toHaveBeenCalled()
  })
})
