import type { ReactElement } from 'react'

import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { StatusPanel } from '../../components/StatusPanel'
import type { FailureState } from '../../feedback/failure'
import { homeFailureAction, homeWorkspaceFailure } from '../../feedback/homeResult'
import { useNavigationStore } from '../../stores/navigation.store'
import type { ImportViewState } from './useProjectImport'

interface ImportResultDialogProps {
  state: ImportViewState
  name?: string
  error?: FailureState | null
  onClose: () => void
  /** 1309 唯一主操作：关闭结果、刷新列表，由工作台未就绪面板继续重建。 */
  onRebuildWorkspace?: () => void
  successActionLabel?: string
  onSuccessAction?: () => void
}

export function ImportResultDialog({
  state,
  name,
  error,
  onClose,
  onRebuildWorkspace,
  successActionLabel = '前往项目选择',
  onSuccessAction
}: ImportResultDialogProps): ReactElement {
  const visit = useNavigationStore((store) => store.visit)
  const open = state !== 'idle' && state !== 'selecting'
  const busy = state === 'inspecting' || state === 'importing'
  const failed = state === 'failure'
  const failureAction = error ? homeFailureAction(error.code) : 'none'
  const workspaceBlocked = failed && failureAction === 'rebuild-workspace'

  return (
    <Dialog
      open={open}
      title="导入项目"
      allowClose={!busy}
      onClose={onClose}
      actions={
        failed ? (
          workspaceBlocked && onRebuildWorkspace ? (
            <Button onClick={onRebuildWorkspace}>{homeWorkspaceFailure.action}</Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
          )
        ) : state === 'success' ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
            <Button
              onClick={() => {
                onClose()
                if (onSuccessAction) onSuccessAction()
                else visit('projects')
              }}
            >
              {successActionLabel}
            </Button>
          </>
        ) : (
          <Button disabled>正在导入…</Button>
        )
      }
    >
      {busy ? <StatusPanel status="busy" title="正在检查项目目录" detail="请稍候。" /> : null}
      {state === 'success' ? (
        <StatusPanel
          status="success"
          title="项目已导入"
          detail={name ? `「${name}」已准备好。` : undefined}
        />
      ) : null}
      {failed ? (
        <StatusPanel
          status="error"
          title={workspaceBlocked ? homeWorkspaceFailure.title : '导入未完成'}
          detail={workspaceBlocked ? homeWorkspaceFailure.detail : error?.msg}
        />
      ) : null}
    </Dialog>
  )
}
