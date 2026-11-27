import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import type { FailureState } from '../../feedback/failure'
import {
  fieldForErrorCode,
  homeWorkspaceFailure,
  workspaceProjectIdFrom
} from '../../feedback/homeResult'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '../../feedback/workbenchFeedback'
import { projectListQueryKey } from '../../pages/projects/useProjectsList'
import { useNavigationStore } from '../../stores/navigation.store'
import type { CreateProjectDTO } from '@application/projects/dto/ProjectDTO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'

export type CreateViewState = 'closed' | 'editing' | 'creating' | 'failure'

export interface CreateFlow {
  state: CreateViewState
  name: string
  synopsis: string
  directory: string
  fieldError: { field: 'name' | 'synopsis'; message: string } | null
  locationError: string | null
  error: FailureState | null
  confirmClose: boolean
  workspaceProjectId: string | null
  rebuilding: boolean
  setName: (value: string) => void
  setSynopsis: (value: string) => void
  open: () => void
  requestClose: () => void
  continueEditing: () => void
  discard: () => void
  chooseLocation: () => Promise<void>
  submit: () => Promise<void>
  retry: () => Promise<void>
  rebuildWorkspace: () => Promise<void>
}

export interface ProjectCreateCallbacks {
  /** 新建工程成功；只交出工程 id，不交出名称、路径或内容。 */
  onProjectCreated?: (projectId: string) => void
}

export function useProjectCreate(
  client: ProjectClient,
  callbacks: ProjectCreateCallbacks = {}
): CreateFlow {
  const queryClient = useQueryClient()
  const [state, setState] = useState<CreateViewState>('closed')
  const [name, setName] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [directory, setDirectory] = useState('')
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'synopsis'
    message: string
  } | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [error, setError] = useState<FailureState | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [pendingRequest, setPendingRequest] = useState<CreateProjectDTO | null>(null)
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)

  const dirty = name.length > 0 || synopsis.length > 0 || directory.length > 0

  function open(): void {
    setState('editing')
    setConfirmClose(false)
    setFieldError(null)
    setLocationError(null)
    setError(null)
  }

  function requestClose(): void {
    if (state === 'creating' || rebuilding) return
    if (dirty && state === 'editing') {
      setConfirmClose(true)
      return
    }
    reset()
  }

  function reset(): void {
    void client.clearSaveLocation()
    setState('closed')
    setName('')
    setSynopsis('')
    setDirectory('')
    setFieldError(null)
    setLocationError(null)
    setError(null)
    setConfirmClose(false)
    setPendingRequest(null)
    setWorkspaceProjectId(null)
  }

  async function chooseLocation(): Promise<void> {
    if (state === 'creating' || rebuilding) return
    setLocationError(null)
    const ajax = await client.chooseSaveLocation()
    if (ajax.code === 2000 && ajax.data?.directory) {
      setDirectory(ajax.data.directory)
      return
    }
    if (ajax.code !== 2000) setLocationError(ajax.msg)
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) {
      setFieldError({ field: 'name', message: '请填写项目名称' })
      return
    }
    if (!directory) {
      setLocationError('请选择保存位置')
      return
    }
    const request: CreateProjectDTO = {
      operationId: crypto.randomUUID(),
      name: trimmed,
      synopsis: synopsis || undefined
    }
    setPendingRequest(request)
    await create(request)
  }

  async function create(request: CreateProjectDTO): Promise<void> {
    setState('creating')
    setFieldError(null)
    setLocationError(null)
    const ajax = await client.createProject(request)
    if (ajax.code === 2000 && ajax.data?.status === 'cancelled') {
      setState('editing')
      return
    }
    if (ajax.code === 2000 && ajax.data?.status === 'completed') {
      const completed = ajax.data
      callbacks.onProjectCreated?.(completed.projectId)
      void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
      reset()
      useNavigationStore.getState().openWorkbench({
        id: completed.projectId,
        name: completed.name
      })
      toast('项目已创建')
      return
    }
    const field = fieldForErrorCode(ajax.code)
    if (field) {
      setFieldError({ field, message: ajax.msg })
      setState('editing')
      return
    }
    const projectId = workspaceProjectIdFrom(ajax.data)
    if (ajax.code === PROJECT_WORKSPACE_NOT_READY_CODE) {
      setWorkspaceProjectId(projectId)
      void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
      setError({ code: ajax.code, msg: homeWorkspaceFailure.detail })
      setState('failure')
      return
    }
    setWorkspaceProjectId(null)
    setError({ code: ajax.code, msg: ajax.msg })
    setState('failure')
  }

  async function retry(): Promise<void> {
    if (pendingRequest) await create(pendingRequest)
  }

  async function rebuildWorkspace(): Promise<void> {
    if (state !== 'failure' || rebuilding) return
    const projectId = workspaceProjectId
    const projectName = name.trim()
    setRebuilding(true)
    try {
      if (projectId) {
        const ensured = await client.ensureProjectWorkspace({ projectId })
        if (ensured.code === 2000 && ensured.data) {
          void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
          reset()
          useNavigationStore.getState().openWorkbench({ id: projectId, name: projectName })
          return
        }
      }
      reset()
      void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
      useNavigationStore.getState().visit('projects')
    } finally {
      setRebuilding(false)
    }
  }

  return {
    state,
    name,
    synopsis,
    directory,
    fieldError,
    locationError,
    error,
    confirmClose,
    workspaceProjectId,
    rebuilding,
    setName: (value: string) => {
      setName(value)
      if (fieldError?.field === 'name') setFieldError(null)
    },
    setSynopsis,
    open,
    requestClose,
    continueEditing: () => setConfirmClose(false),
    discard: reset,
    chooseLocation,
    submit,
    retry,
    rebuildWorkspace
  }
}
