import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import type { FailureState } from '../../feedback/failure'
import { homeWorkspaceFailure } from '../../feedback/homeResult'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '../../feedback/workbenchFeedback'
import { projectListQueryKey } from '../../pages/projects/useProjectsList'
import { useNavigationStore } from '../../stores/navigation.store'
import type { ProjectOperationVO } from '@application/projects/vo/ProjectVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'

export type ImportViewState =
  'idle' | 'selecting' | 'inspecting' | 'importing' | 'success' | 'failure'

export interface ProjectImportFlow {
  state: ImportViewState
  result: Extract<ProjectOperationVO, { status: 'completed' }> | null
  error: FailureState | null
  importProject: () => Promise<void>
  dismiss: () => void
  rebuildWorkspace: () => void
}

export function useProjectImport(client: ProjectClient): ProjectImportFlow {
  const queryClient = useQueryClient()
  const [state, setState] = useState<ImportViewState>('idle')
  const [result, setResult] = useState<Extract<ProjectOperationVO, { status: 'completed' }> | null>(
    null
  )
  const [error, setError] = useState<FailureState | null>(null)

  async function importProject(): Promise<void> {
    const operationId = crypto.randomUUID()
    setState('selecting')
    setError(null)
    setResult(null)
    const ajax = await client.importProject({ operationId }, (progress) => {
      if (progress.stage === 'inspecting') setState('inspecting')
      if (progress.stage === 'initializing' || progress.stage === 'registering')
        setState('importing')
    })
    if (ajax.code === 2000 && ajax.data?.status === 'cancelled') {
      setState('idle')
      return
    }
    if (ajax.code === 2000 && ajax.data?.status === 'completed') {
      setResult(ajax.data)
      setState('success')
      void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
      return
    }
    if (ajax.code === PROJECT_WORKSPACE_NOT_READY_CODE) {
      // 导入已登记但工作区未就绪：固定安全文案，刷新列表让工程卡可见。
      void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
      setError({ code: ajax.code, msg: homeWorkspaceFailure.detail })
      setState('failure')
      return
    }
    setError({ code: ajax.code, msg: ajax.msg })
    setState('failure')
  }

  function dismiss(): void {
    setState('idle')
    setError(null)
    setResult(null)
  }

  /** 关闭导入结果并回到工程列表；打开工程后由工作台未就绪面板继续重建。 */
  function rebuildWorkspace(): void {
    dismiss()
    void queryClient.invalidateQueries({ queryKey: projectListQueryKey })
    useNavigationStore.getState().visit('projects')
  }

  return { state, result, error, importProject, dismiss, rebuildWorkspace }
}
