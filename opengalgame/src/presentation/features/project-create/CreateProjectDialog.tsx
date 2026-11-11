import { useEffect, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Dialog } from '../../components/Dialog'
import { FormField, TextArea, TextInput } from '../../components/FormField'
import { StatusPanel } from '../../components/StatusPanel'
import { homeFailureAction, homeWorkspaceFailure } from '../../feedback/homeResult'
import styles from './CreateProjectDialog.module.css'
import type { CreateFlow } from './useProjectCreate'

export function CreateProjectDialog({ flow }: { flow: CreateFlow }): ReactElement {
  const open = flow.state === 'editing' || flow.state === 'creating' || flow.state === 'failure'
  const busy = flow.state === 'creating' || flow.rebuilding
  const failureAction = flow.error ? homeFailureAction(flow.error.code) : 'none'

  useEffect(() => {
    if (flow.fieldError?.field === 'name')
      document.querySelector<HTMLInputElement>('#project-name')?.focus({ preventScroll: true })
  }, [flow.fieldError])

  return (
    <>
      <Dialog
        open={open && !flow.confirmClose}
        title="新建项目"
        allowClose={!busy}
        onClose={flow.requestClose}
        actions={
          flow.state === 'failure' && flow.error && failureAction === 'retry-registration' ? (
            <>
              <Button variant="secondary" onClick={flow.requestClose}>
                关闭
              </Button>
              <Button onClick={() => void flow.retry()}>重试登记</Button>
            </>
          ) : flow.state === 'failure' && flow.error && failureAction === 'rebuild-workspace' ? (
            <Button onClick={() => void flow.rebuildWorkspace()} disabled={flow.rebuilding}>
              {flow.rebuilding ? homeWorkspaceFailure.rebuilding : homeWorkspaceFailure.action}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={flow.requestClose} disabled={busy}>
                取消
              </Button>
              <Button onClick={() => void flow.submit()} disabled={busy}>
                {flow.state === 'creating' ? '正在创建…' : '创建项目'}
              </Button>
            </>
          )
        }
      >
        {flow.state !== 'failure' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void flow.submit()
            }}
          >
            <FormField
              label="项目名称"
              htmlFor="project-name"
              error={flow.fieldError?.field === 'name' ? flow.fieldError.message : undefined}
            >
              <TextInput
                id="project-name"
                value={flow.name}
                onChange={(event) => flow.setName(event.target.value)}
                placeholder="为你的故事起个名字"
                autoComplete="off"
                maxLength={40}
              />
            </FormField>
            <FormField label="项目简介" optional="选填" htmlFor="project-synopsis">
              <TextArea
                id="project-synopsis"
                value={flow.synopsis}
                onChange={(event) => flow.setSynopsis(event.target.value)}
                placeholder="用一两句话记下这个故事"
                rows={4}
              />
            </FormField>
            <FormField
              label="保存位置"
              htmlFor="project-save-location"
              error={flow.locationError ?? undefined}
            >
              <div className={styles.locationRow}>
                <TextInput
                  id="project-save-location"
                  value={flow.directory}
                  placeholder="尚未选择"
                  readOnly
                  title={flow.directory || undefined}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void flow.chooseLocation()}
                >
                  {flow.directory ? '更改' : '选择文件夹'}
                </Button>
              </div>
            </FormField>
          </form>
        ) : null}
        {busy ? (
          <StatusPanel
            status="busy"
            title={flow.rebuilding ? homeWorkspaceFailure.rebuilding : '正在创建…'}
            detail={flow.rebuilding ? '正在核对工程文件，完成后会自动继续。' : '正在准备空白画布。'}
          />
        ) : null}
        {flow.state === 'failure' && flow.error ? (
          <StatusPanel
            status="error"
            title={
              failureAction === 'rebuild-workspace'
                ? homeWorkspaceFailure.title
                : failureAction === 'retry-registration'
                  ? '工程已保存，登记未完成'
                  : '创建未完成'
            }
            detail={
              failureAction === 'rebuild-workspace' ? homeWorkspaceFailure.detail : flow.error.msg
            }
          />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={flow.confirmClose}
        title="放弃修改"
        message="有未提交的修改。要继续编辑，还是放弃修改？"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        onConfirm={flow.discard}
        onCancel={flow.continueEditing}
      />
    </>
  )
}
