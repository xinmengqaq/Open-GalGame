import { Check, CircleAlert, FolderOpen, Loader2, X } from 'lucide-react'
import { useState, type ReactElement } from 'react'

import styles from './SceneExportNotice.module.css'

export type SceneExportNotice = {
  tone: 'busy' | 'ok' | 'danger' | 'warning'
  label: string
  detail: string | null
  /** 导出成功时的产物目录绝对路径；只由导出结果带出，用于展示和打开。 */
  directoryPath?: string | null
}

/** 打开目录失败时给用户的可执行下一步；具体失败不吞，仍由调用方保留异常。 */
export const openDirectoryFailureNote = '无法打开文件夹，请手动打开上面的路径'

interface SceneExportNoticeProps {
  notice: SceneExportNotice | null
  onDismiss: () => void
  /** 交给系统打开产物目录；缺省时只展示路径，不显示打开按钮。 */
  onOpenDirectory?: (directoryPath: string) => Promise<void>
}

/**
 * 导出提示浮层：固定在工作台反馈安全位，不参与顶栏或弹窗布局。
 * 只呈现一条导出状态，成功时补上完整产物路径与打开动作；
 * 不抢焦点，只让结果本身可读、可操作。
 */
export function SceneExportNoticeCard({
  notice,
  onDismiss,
  onOpenDirectory
}: SceneExportNoticeProps): ReactElement | null {
  if (!notice) return null
  return (
    <SceneExportNoticeContent
      key={[notice.tone, notice.label, notice.detail ?? '', notice.directoryPath ?? ''].join('|')}
      notice={notice}
      onDismiss={onDismiss}
      onOpenDirectory={onOpenDirectory}
    />
  )
}

interface SceneExportNoticeContentProps {
  notice: SceneExportNotice
  onDismiss: () => void
  onOpenDirectory?: (directoryPath: string) => Promise<void>
}

/** 每次导出提示变化都从头展示：旧的“打开中/失败”不带到新结果上。 */
function SceneExportNoticeContent({
  notice,
  onDismiss,
  onOpenDirectory
}: SceneExportNoticeContentProps): ReactElement {
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const directoryPath = notice.tone === 'ok' ? (notice.directoryPath ?? null) : null
  const canDismiss = notice.tone !== 'busy'
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
    <aside
      className={styles.notice}
      data-tone={notice.tone}
      data-testid="scene-export-notice"
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      title={title}
    >
      <span className={styles.signal} aria-hidden="true">
        {notice.tone === 'busy' ? (
          <Loader2 className={styles.spinner} />
        ) : notice.tone === 'ok' ? (
          <Check />
        ) : (
          <CircleAlert />
        )}
      </span>
      <div className={styles.content}>
        <p className={styles.headline}>
          <strong>{notice.label}</strong>
          {notice.detail === null ? null : <span className={styles.detail}>{notice.detail}</span>}
        </p>
        {directoryPath === null ? null : (
          <div className={styles.pathBlock}>
            <span className={styles.pathLabel}>产物位置</span>
            <code className={styles.path} title={directoryPath}>
              {directoryPath}
            </code>
          </div>
        )}
        {openError === null ? null : (
          <p className={styles.openError} role="alert">
            {openError}
          </p>
        )}
        {directoryPath === null || onOpenDirectory === undefined ? null : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.openAction}
              disabled={opening}
              aria-busy={opening || undefined}
              onClick={() => void openDirectory()}
            >
              {opening ? (
                <Loader2 className={styles.spinner} aria-hidden="true" />
              ) : (
                <FolderOpen aria-hidden="true" />
              )}
              <span>{opening ? '正在打开…' : '打开所在文件夹'}</span>
            </button>
          </div>
        )}
      </div>
      {canDismiss ? (
        <button
          type="button"
          className={styles.dismiss}
          aria-label="收起导出结果"
          title="收起"
          onClick={onDismiss}
        >
          <X />
        </button>
      ) : null}
    </aside>
  )
}
