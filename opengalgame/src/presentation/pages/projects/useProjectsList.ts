import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { failureOf, requireSuccess, type FailureState } from '../../feedback/failure'
import { useNavigationStore } from '../../stores/navigation.store'
import type { ProjectListEntryVO } from '@application/projects/vo/ProjectVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'

export const PROJECTS_PAGE_SIZE = 9

export type ProjectsListStatus = 'loading' | 'ready' | 'empty' | 'failed'

export const projectListQueryKey = ['projects'] as const

const projectsQueryKey = (offset: number): readonly [string, number] => [
  projectListQueryKey[0],
  offset
]

export interface ProjectsList {
  status: ProjectsListStatus
  entries: ProjectListEntryVO[]
  total: number
  offset: number
  selectedId: string | null
  error: FailureState | null
  refreshError: FailureState | null
  select: (id: string) => void
  openProject: (id: string) => Promise<void>
  renameProject: (id: string, name: string, synopsis: string) => Promise<FailureState | null>
  unregisterProject: (id: string) => Promise<void>
  retry: () => Promise<void>
  goPreviousPage: () => void
  goNextPage: () => void
}

export function useProjectsList(client: ProjectClient): ProjectsList {
  const queryClient = useQueryClient()
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionFailure, setActionFailure] = useState<{
    failure: FailureState
    readAt: number
  } | null>(null)

  const page = useQuery({
    queryKey: projectsQueryKey(offset),
    queryFn: async () =>
      requireSuccess(await client.listProjects({ offset, limit: PROJECTS_PAGE_SIZE })),
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
    retry: false
  })

  const entries = page.data?.entries ?? []
  const total = page.data?.total ?? 0
  const failure = page.error === null ? null : failureOf(page.error)

  const actionBanner =
    actionFailure && actionFailure.readAt === page.dataUpdatedAt ? actionFailure.failure : null

  const status: ProjectsListStatus = page.isPending
    ? 'loading'
    : failure && !page.data
      ? 'failed'
      : total === 0
        ? 'empty'
        : 'ready'

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: projectListQueryKey })
  }

  async function openProject(id: string): Promise<void> {
    const entry = entries.find((item) => item.id === id)
    if (!entry || entry.status !== 'available') return
    try {
      const summary = requireSuccess(await client.openProject({ id }))
      useNavigationStore.getState().openWorkbench({ id: summary.id, name: summary.name })
    } catch (error) {
      setActionFailure({ failure: failureOf(error), readAt: page.dataUpdatedAt })
    }
  }

  async function renameProject(
    id: string,
    name: string,
    synopsis: string
  ): Promise<FailureState | null> {
    try {
      requireSuccess(await client.renameProject({ id, name, synopsis: synopsis || undefined }))
    } catch (error) {
      return failureOf(error)
    }
    setSelectedId(id)
    await refresh()
    return null
  }

  async function unregisterProject(id: string): Promise<void> {
    try {
      requireSuccess(await client.unregisterProject({ id }))
    } catch (error) {
      setActionFailure({ failure: failureOf(error), readAt: page.dataUpdatedAt })
      return
    }
    setSelectedId((current) => (current === id ? null : current))
    if (entries.length <= 1 && offset > 0) setOffset(Math.max(0, offset - PROJECTS_PAGE_SIZE))
    else await refresh()
  }

  return {
    status,
    entries,
    total,
    offset,
    selectedId,
    error: failure && !page.data ? failure : null,
    refreshError: actionBanner ?? (failure && page.data ? failure : null),
    select: setSelectedId,
    openProject,
    renameProject,
    unregisterProject,
    retry: refresh,
    goPreviousPage: () => {
      setSelectedId(null)
      setOffset((current) => Math.max(0, current - PROJECTS_PAGE_SIZE))
    },
    goNextPage: () => {
      setSelectedId(null)
      setOffset((current) => current + PROJECTS_PAGE_SIZE)
    }
  }
}
