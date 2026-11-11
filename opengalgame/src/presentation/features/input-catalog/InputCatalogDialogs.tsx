import { useEffect, type ReactElement } from 'react'

import type { ProjectFolderDeletionPlanVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import { Button } from '../../components/Button'
import { DangerAction } from '../../components/DangerAction'
import { Dialog } from '../../components/Dialog'
import { FormField, TextInput } from '../../components/FormField'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { contentKindLabel } from '../workbench-session/contentKindLabel'
import {
  AlertIcon,
  ChevronIcon,
  FileGlyphIcon,
  FolderIcon,
  ImageGlyphIcon,
  SparkIcon,
  TrashIcon
} from './InputCatalogIcons'
import type { CatalogNameDialog } from './inputCatalog.types'
import styles from './InputCatalogPanel.module.css'

interface CatalogNameDialogProps {
  dialog: CatalogNameDialog
  busy: boolean
  onName: (value: string) => void
  onSubmit: () => void
  onClose: () => void
}

/** 新建文件夹、重命名文件与文件夹共用一处命名表单。 */
export function CatalogNameDialogView({
  dialog,
  busy,
  onName,
  onSubmit,
  onClose
}: CatalogNameDialogProps): ReactElement {
  const open = dialog !== null
  const title =
    dialog?.kind === 'create-folder'
      ? '新建文件夹'
      : dialog?.kind === 'rename-folder'
        ? '重命名文件夹'
        : '重命名文件'
  const label = dialog?.kind === 'rename-file' ? '文件名' : '文件夹名'
  const hint =
    dialog?.kind === 'rename-file'
      ? '名称包含扩展名。同一目录中的名称不能重复。'
      : '文件夹名在同一父目录下不能重复。'

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById('catalog-name-draft')
      if (!(input instanceof HTMLInputElement)) return
      input.focus({ preventScroll: true })
      input.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Dialog
      open={open}
      title={title}
      allowClose={!busy}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={onSubmit}>
            确定
          </Button>
        </>
      }
    >
      <form
        className={styles.dialogForm}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <FormField label={label} htmlFor="catalog-name-draft" error={dialog?.error ?? undefined}>
          <TextInput
            id="catalog-name-draft"
            value={dialog?.name ?? ''}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => onName(event.target.value)}
          />
        </FormField>
        <p className={styles.dialogHint}>{hint}</p>
      </form>
    </Dialog>
  )
}

interface CatalogCreateDialogProps {
  open: boolean
  busy: boolean
  onClose: () => void
  onChooseDocument: () => void
  onChooseMedia: () => void
}

/** 新建素材入口：文档进入空编辑器，媒体走导入。 */
export function CatalogCreateDialog({
  open,
  busy,
  onClose,
  onChooseDocument,
  onChooseMedia
}: CatalogCreateDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      title="新建素材"
      allowClose={!busy}
      onClose={onClose}
      actions={
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          取消
        </Button>
      }
    >
      <p className={styles.dialogLead}>选择要新建的素材类型。</p>
      <div className={styles.chooser}>
        <button
          type="button"
          className={styles.chooserCard}
          disabled={busy}
          onClick={onChooseDocument}
        >
          <span className={styles.chooserIcon} data-tone="document" aria-hidden="true">
            <FileGlyphIcon />
          </span>
          <span className={styles.chooserCopy}>
            <strong>文档</strong>
            <span>打开空文档编辑器，正文保存为工程中的真实文档。</span>
          </span>
          <span className={styles.chooserArrow} aria-hidden="true">
            <ChevronIcon />
          </span>
        </button>
        <button
          type="button"
          className={styles.chooserCard}
          disabled={busy}
          onClick={onChooseMedia}
        >
          <span className={styles.chooserIcon} data-tone="image" aria-hidden="true">
            <ImageGlyphIcon />
          </span>
          <span className={styles.chooserCopy}>
            <strong>图片 / 音频 / 视频</strong>
            <span>从本机选择文件，导入当前目录，再拖入画布使用。</span>
          </span>
          <span className={styles.chooserArrow} aria-hidden="true">
            <ChevronIcon />
          </span>
        </button>
      </div>
      <p className={styles.dialogHint}>
        <SparkIcon />
        提示词、动画和特效卡片在画布底栏添加。
      </p>
    </Dialog>
  )
}

interface DeleteFileDialogProps {
  target: ProjectInputSourceSummaryVO | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** 删除文件确认。 */
export function CatalogDeleteFileDialog({
  target,
  busy,
  onCancel,
  onConfirm
}: DeleteFileDialogProps): ReactElement {
  const textKind = target?.contentKind === 'text' ? target.textKind : undefined
  return (
    <Dialog
      open={target !== null}
      title="删除文件"
      size="narrow"
      allowClose={!busy}
      onClose={onCancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <DangerAction
            label="删除"
            emphasis="solid"
            icon={<TrashIcon />}
            disabled={busy}
            onClick={onConfirm}
          />
        </>
      }
    >
      {target ? (
        <div className={styles.deleteBody}>
          <div className={styles.deleteTarget}>
            <span className={styles.deleteTargetIcon} aria-hidden="true">
              <FileGlyphIcon />
            </span>
            <span className={styles.deleteTargetText}>
              <strong title={target.name}>{target.name}</strong>
              <small>{contentKindLabel(target.contentKind, textKind)}</small>
            </span>
          </div>
          <p className={styles.deleteWarning}>
            <AlertIcon />
            {workbenchFeedback.deleteConfirm}
          </p>
        </div>
      ) : null}
    </Dialog>
  )
}

interface DeleteFolderDialogProps {
  plan: ProjectFolderDeletionPlanVO | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** 删除文件夹确认，显示将会删除的子树规模。 */
export function CatalogDeleteFolderDialog({
  plan,
  busy,
  onCancel,
  onConfirm
}: DeleteFolderDialogProps): ReactElement {
  return (
    <Dialog
      open={plan !== null}
      title="删除文件夹"
      size="narrow"
      allowClose={!busy}
      onClose={onCancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <DangerAction
            label="删除"
            emphasis="solid"
            icon={<TrashIcon />}
            disabled={busy}
            onClick={onConfirm}
          />
        </>
      }
    >
      {plan ? (
        <div className={styles.deleteBody}>
          <div className={styles.deleteTarget}>
            <span className={styles.deleteTargetIcon} data-tone="folder" aria-hidden="true">
              <FolderIcon open />
            </span>
            <span className={styles.deleteTargetText}>
              <strong title={plan.name}>{plan.name}</strong>
              <small>文件夹及其子树</small>
            </span>
          </div>
          <div className={styles.deleteStats}>
            <span>
              <strong>{plan.folderCount}</strong>
              个文件夹
            </span>
            <span>
              <strong>{plan.fileCount}</strong>
              个文件
            </span>
          </div>
          <p className={styles.deleteWarning}>
            <AlertIcon />
            {workbenchFeedback.deleteFolderConfirm(plan.name, plan.folderCount, plan.fileCount)}
          </p>
        </div>
      ) : null}
    </Dialog>
  )
}
