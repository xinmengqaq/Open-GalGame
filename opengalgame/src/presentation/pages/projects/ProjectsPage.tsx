import { useRef, useState, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import { ArrowIcon, DownloadIcon, PlusIcon } from '../../components/Icons'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Dialog } from '../../components/Dialog'
import { FormField, TextArea, TextInput } from '../../components/FormField'
import { CreateProjectDialog } from '../../features/project-create/CreateProjectDialog'
import { useProjectCreate } from '../../features/project-create/useProjectCreate'
import { ImportResultDialog } from '../../features/project-import/ImportResultDialog'
import { useProjectImport } from '../../features/project-import/useProjectImport'
import type { FailureState } from '../../feedback/failure'
import { fieldForErrorCode } from '../../feedback/homeResult'
import { useNavigationStore } from '../../stores/navigation.store'
import { NewProjectCard } from './NewProjectCard'
import { LibraryStateArtwork } from './ProjectsStateArtwork'
import { ProjectCard } from './ProjectCard'
import styles from './ProjectsPage.module.css'
import { PROJECTS_PAGE_SIZE, useProjectsList } from './useProjectsList'
import { useProjectsMotion } from './useProjectsMotion'
import type { ProjectListEntryVO } from '@application/projects/vo/ProjectVO'
import type { ProjectClient } from '@interfaces/client/ProjectClient'

interface ProjectsPageProps {
  projectClient: ProjectClient
  onProjectCreated?: (projectId: string) => void
}

export function ProjectsPage({ projectClient, onProjectCreated }: ProjectsPageProps): ReactElement {
  const visit = useNavigationStore((state) => state.visit)
  const creating = useProjectCreate(projectClient, { onProjectCreated })
  const importing = useProjectImport(projectClient)
  const list = useProjectsList(projectClient)
  const root = useRef<HTMLElement>(null)
  useProjectsMotion(root, list.status)

  const [renameTarget, setRenameTarget] = useState<Extract<
    ProjectListEntryVO,
    { status: 'available' }
  > | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameSynopsis, setRenameSynopsis] = useState('')
  const [renameFailure, setRenameFailure] = useState<FailureState | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ProjectListEntryVO | null>(null)

  const flowBusy =
    creating.state === 'creating' ||
    importing.state === 'selecting' ||
    importing.state === 'inspecting' ||
    importing.state === 'importing'
  const pageNumber = Math.floor(list.offset / PROJECTS_PAGE_SIZE) + 1
  const showPager = list.total > PROJECTS_PAGE_SIZE
  const countLabel =
    list.status === 'loading'
      ? '正在读取'
      : list.status === 'failed'
        ? '加载失败'
        : `${list.total} 部作品`
  const renameSynopsisFailure =
    renameFailure && fieldForErrorCode(renameFailure.code) === 'synopsis'
      ? renameFailure.msg
      : undefined
  const renameNameFailure = renameFailure && !renameSynopsisFailure ? renameFailure.msg : undefined

  function openCreate(): void {
    if (flowBusy || importing.state !== 'idle') return
    creating.open()
  }

  function openImport(): void {
    if (flowBusy || creating.state !== 'closed') return
    void importing.importProject()
  }

  function openRename(entry: Extract<ProjectListEntryVO, { status: 'available' }>): void {
    setRenameTarget(entry)
    setRenameName(entry.name)
    setRenameSynopsis(entry.synopsis)
    setRenameFailure(null)
  }

  async function submitRename(): Promise<void> {
    if (!renameTarget) return
    if (!renameName.trim()) return
    const failure = await list.renameProject(renameTarget.id, renameName, renameSynopsis)
    if (failure) {
      setRenameFailure(failure)
      return
    }
    setRenameTarget(null)
  }

  return (
    <section className={styles.screen} ref={root} aria-label="项目">
      <div className={styles.wash} aria-hidden="true" />
      <header className={styles.topbar}>
        <button
          type="button"
          className={styles.backButton}
          aria-label="返回"
          data-tip="返回"
          onClick={() => visit('home')}
        >
          <ArrowIcon className={styles.backIcon} />
        </button>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>项目</h1>
          <span className={styles.count} aria-live="polite">
            {countLabel}
          </span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.action} ${styles.actionSecondary}`}
            disabled={flowBusy}
            onClick={openCreate}
          >
            <PlusIcon className={styles.actionIcon} />
            <span>新建</span>
          </button>
          <button
            type="button"
            className={`${styles.action} ${styles.actionPrimary}`}
            disabled={flowBusy}
            onClick={openImport}
          >
            <DownloadIcon className={styles.actionIcon} />
            <span>导入</span>
          </button>
        </div>
      </header>
      {list.refreshError ? (
        <p className={styles.banner} role="status">
          {list.refreshError.msg}
        </p>
      ) : null}
      <div className={styles.stage}>
        {list.status === 'loading' ? (
          <div className={styles.grid} aria-busy="true" aria-label="正在加载项目">
            {Array.from({ length: PROJECTS_PAGE_SIZE + 1 }, (_, index) => (
              <div key={index} className={styles.skeleton} />
            ))}
          </div>
        ) : null}
        {list.status === 'failed' ? (
          <div className={styles.stateCenter}>
            <div className={styles.statePanel} data-kind="failed" role="alert">
              <div className={`${styles.stateVisual} ${styles.stateVisualFailed}`}>
                <LibraryStateArtwork failed />
              </div>
              <div className={styles.stateCopy}>
                <h2 className={styles.stateTitle}>{list.error?.msg ?? '项目列表加载失败'}</h2>
                <p className={styles.stateDetail}>
                  工程文件没有被修改；重新加载仍然失败时，检查工程目录是否可访问。
                </p>
                <button
                  type="button"
                  className={styles.stateAction}
                  onClick={() => void list.retry()}
                >
                  重试
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {list.status === 'empty' ? (
          <div className={styles.stateCenter}>
            <div className={styles.statePanel}>
              <div className={styles.stateVisual}>
                <LibraryStateArtwork />
              </div>
              <div className={styles.stateCopy}>
                <h2 className={styles.stateTitle}>还没有作品</h2>
                <NewProjectCard onCreate={openCreate} />
              </div>
            </div>
          </div>
        ) : null}
        {list.status === 'ready' ? (
          <div className={styles.grid}>
            {list.entries.map((entry) => (
              <ProjectCard
                key={entry.id}
                entry={entry}
                selected={list.selectedId === entry.id}
                onSelect={() => list.select(entry.id)}
                onOpen={() => void list.openProject(entry.id)}
                onRename={() => {
                  if (entry.status === 'available') openRename(entry)
                }}
                onUnregister={() => setRemoveTarget(entry)}
              />
            ))}
            <NewProjectCard onCreate={openCreate} />
          </div>
        ) : null}
      </div>
      {showPager ? (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.pagerButton}
            disabled={list.offset === 0}
            onClick={list.goPreviousPage}
          >
            上一页
          </button>
          <span className={styles.pageLabel}>第 {pageNumber} 页</span>
          <button
            type="button"
            className={styles.pagerButton}
            disabled={list.offset + PROJECTS_PAGE_SIZE >= list.total}
            onClick={list.goNextPage}
          >
            下一页
          </button>
        </div>
      ) : null}
      <CreateProjectDialog flow={creating} />
      <ImportResultDialog
        state={importing.state}
        name={importing.result?.name}
        error={importing.error}
        onClose={importing.dismiss}
        onRebuildWorkspace={importing.rebuildWorkspace}
        successActionLabel="返回列表"
      />
      <Dialog
        open={renameTarget !== null}
        title="重命名"
        allowClose
        onClose={() => setRenameTarget(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void submitRename()}>保存</Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submitRename()
          }}
        >
          <FormField
            label="项目名称"
            htmlFor="rename-project-name"
            error={renameName.trim() ? renameNameFailure : '请填写项目名称'}
          >
            <TextInput
              id="rename-project-name"
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
              autoComplete="off"
              maxLength={40}
            />
          </FormField>
          <FormField
            label="项目简介"
            optional="选填"
            htmlFor="rename-project-synopsis"
            error={renameSynopsisFailure}
          >
            <TextArea
              id="rename-project-synopsis"
              value={renameSynopsis}
              onChange={(event) => setRenameSynopsis(event.target.value)}
              rows={4}
            />
          </FormField>
        </form>
      </Dialog>
      <ConfirmDialog
        open={removeTarget !== null}
        title="移出列表"
        message="把这部作品从列表中拿掉？文件夹仍留在原来的位置。"
        confirmLabel="移出列表"
        cancelLabel="留下"
        onConfirm={() => {
          if (removeTarget) void list.unregisterProject(removeTarget.id)
          setRemoveTarget(null)
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  )
}
