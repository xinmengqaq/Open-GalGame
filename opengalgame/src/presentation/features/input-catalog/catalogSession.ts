import { type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { ProjectInputCatalogVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'

export function projectInputSourcesQueryKey(
  projectId: string
): readonly ['project-input-sources', string] {
  return ['project-input-sources', projectId]
}

export async function fetchProjectInputSources(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string
): Promise<readonly ProjectInputSourceSummaryVO[]> {
  const catalog = await queryClient.fetchQuery({
    queryKey: projectInputSourcesQueryKey(projectId),
    queryFn: async () => requireSuccess(await client.listProjectInputSources({ projectId })),
    staleTime: 0
  })
  return catalog.sources
}

/** 读取缓存中的目录版本。没有快照时为空字符串。 */
export function catalogVersion(queryClient: QueryClient, projectId: string): string {
  return (
    queryClient.getQueryData<ProjectInputCatalogVO>(projectInputSourcesQueryKey(projectId))
      ?.catalogVersion ?? ''
  )
}

/** 操作返回时工程是否仍是发起时的工程。 */
export function stillCurrentProject(projectId: string): boolean {
  return useWorkbenchSessionStore.getState().projectId === projectId
}

export async function reloadCatalog(
  client: ProjectFilesClient,
  queryClient: QueryClient,
  projectId: string
): Promise<void> {
  try {
    const sources = await fetchProjectInputSources(client, queryClient, projectId)
    if (!stillCurrentProject(projectId)) return
    useWorkbenchSessionStore.getState().setCatalog(sources)
  } catch (error) {
    if (!stillCurrentProject(projectId)) return
    const failure = failureOf(error)
    const cached = queryClient.getQueryData<ProjectInputCatalogVO>(
      projectInputSourcesQueryKey(projectId)
    )
    if (cached) {
      const store = useWorkbenchSessionStore.getState()
      store.setCatalog(cached.sources)
      store.setCatalogFailure(failure)
      return
    }
    useWorkbenchSessionStore.getState().setCatalogFailure(failure)
    toast(workbenchFeedback.catalogScanFailed)
  }
}
