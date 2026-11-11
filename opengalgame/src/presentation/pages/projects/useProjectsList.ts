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

/**
 * 项目页列表查询、选中、翻页与文件操作。缓存、竞态与旧页保留由数据层承担。
 * 操作失败连同发生时的读取版本一起记下，下次成功读取后自然不再匹配，无需清除。
 * 实现思路：全局缓存不过期、默认挂载不会重取，进入项目页仍要读取当前页，故挂载时强制重取。
 */
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

  /** 失效项目列表缓存，触发当前页重取。 */
  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: projectListQueryKey })
  }

  /** 打开可用项目并进入工作区，失败记入操作横幅。 */
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

  /** 重命名项目，失败返回可展示的失败对象。 */
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
