import { Check, CircleAlert, FolderOpen, Loader2, X } from 'lucide-react'
import { useState, type ReactElement } from 'react'

import styles from './workbenchShell.module.css'

export type SceneExportNotice = {
  tone: 'busy' | 'ok' | 'danger' | 'warning'
  label: string
  detail: string | null
  /** 导出成功时的产物目录绝对路径；只由导出结果带出，用于展示和打开。 */
  directoryPath?: string | null
}

/** 打开目录失败时给用户的可执行下一步；具体失败不吞，仍由调用方保留异常。 */
export const openDirectoryFailureNote = '无法打开文件夹，请手动打开上面的路径'

interface SceneExportStatusProps {
  notice: SceneExportNotice | null
  onDismiss: () => void
  /** 交给系统打开产物目录；缺省时只展示路径，不显示打开按钮。 */
  onOpenDirectory?: (directoryPath: string) => Promise<void>
}

/** 导出状态紧贴场景工具，只用一条短状态表达；完整原因留在 tooltip。 */
export function SceneExportStatus({
  notice,
  onDismiss,
  onOpenDirectory
}: SceneExportStatusProps): ReactElement | null {
  if (!notice) return null
  return (
    <SceneExportStatusContent
      key={exportNoticeKey(notice)}
      notice={notice}
      onDismiss={onDismiss}
      onOpenDirectory={onOpenDirectory}
    />
  )
}

interface SceneExportStatusContentProps {
  notice: SceneExportNotice
  onDismiss: () => void
  onOpenDirectory?: (directoryPath: string) => Promise<void>
}

/** 每次导出提示变化都从头展示：旧的“打开中/失败”不带到新结果上。 */
function SceneExportStatusContent({
  notice,
  onDismiss,
  onOpenDirectory
}: SceneExportStatusContentProps): ReactElement {
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const directoryPath = notice.tone === 'ok' ? (notice.directoryPath ?? null) : null
  const expanded = directoryPath !== null
  const title = notice.detail ?? notice.label

  const openDirectory = async (): Promise<void> => {
    if (opening || directoryPath === null || onOpenDirectory === undefined) return
    setOpening(true)
    setOpenError(null)
    try {
      await onOpenDirectory(directoryPath)
    } catch {
      setOpenError(openDirectoryFailureNote)
    } finally {
      setOpening(false)
    }
  }

  return (
    <span
      className={styles.sceneTaskStatus}
      data-tone={notice.tone}
      data-expanded={expanded ? 'true' : undefined}
      role="status"
      title={title}
    >
      <span className={styles.sceneTaskStatusIcon} aria-hidden="true">
        {notice.tone === 'busy' ? (
          <Loader2 className={styles.sceneTaskSpinner} />
        ) : notice.tone === 'ok' ? (
          <Check />
        ) : (
          <CircleAlert />
        )}
      </span>
      <span className={styles.sceneTaskStatusLabel}>{notice.label}</span>
      {expanded ? (
        <SceneExportOpenDirectory
          directoryPath={directoryPath}
          opening={opening}
          error={openError}
          onOpen={onOpenDirectory === undefined ? undefined : () => void openDirectory()}
          onDismiss={onDismiss}
        />
      ) : notice.tone === 'busy' ? null : (
        <SceneExportDismissButton onDismiss={onDismiss} />
      )}
    </span>
  )
}

export interface SceneExportOpenDirectoryProps {
  directoryPath: string
  opening: boolean
  error: string | null
  onOpen?: () => void
  onDismiss: () => void
}

/**
 * 导出成功提示的第二行：绝对路径与打开目录动作。
 * 打开中禁用按钮并显示「正在打开…」；失败只在提示内补一行用户语言，不另弹窗。
 */
export function SceneExportOpenDirectory({
  directoryPath,
  opening,
  error,
  onOpen,
  onDismiss
}: SceneExportOpenDirectoryProps): ReactElement {
  return (
    <span className={styles.sceneTaskStatusBody}>
      <span className={styles.sceneTaskStatusPath} title={directoryPath}>
        <span className={styles.sceneTaskStatusPathLabel}>已导出到：</span>
        <span className={styles.sceneTaskStatusPathValue}>{directoryPath}</span>
      </span>
      <span className={styles.sceneTaskStatusActions}>
        {onOpen === undefined ? null : (
          <button
            type="button"
            className={styles.sceneTaskStatusAction}
            disabled={opening}
            aria-busy={opening || undefined}
            onClick={onOpen}
          >
            {opening ? (
              <Loader2 className={styles.sceneTaskSpinner} aria-hidden="true" />
            ) : (
              <FolderOpen aria-hidden="true" />
            )}
            <span>{opening ? '正在打开…' : '打开所在文件夹'}</span>
          </button>
        )}
        <SceneExportDismissButton onDismiss={onDismiss} />
      </span>
      {error === null ? null : (
        <span className={styles.sceneTaskStatusError} role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

function SceneExportDismissButton({ onDismiss }: { onDismiss: () => void }): ReactElement {
  return (
    <button
      type="button"
      className={styles.sceneTaskStatusDismiss}
      aria-label="收起导出结果"
      title="收起"
      onClick={onDismiss}
    >
      <X />
    </button>
  )
}

function exportNoticeKey(notice: SceneExportNotice): string {
  return [notice.tone, notice.label, notice.detail ?? '', notice.directoryPath ?? ''].join('|')
}
