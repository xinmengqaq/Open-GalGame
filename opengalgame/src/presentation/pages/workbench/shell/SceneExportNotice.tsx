import { Check, CircleAlert, FolderOpen, Info, Loader2, X } from 'lucide-react'
import { useState, type ReactElement } from 'react'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { failureOf } from '@presentation/feedback/failure'

import styles from './SceneExportNotice.module.css'

export type SceneExportNotice = {
  tone: 'busy' | 'ok' | 'danger' | 'warning'
  label: string
  detail: string | null
  /** 导出成功时的产物目录绝对路径；只由导出结果带出，用于展示和打开。 */
  directoryPath?: string | null
}

/** 打开目录只代表请求已交给系统，窗口是否出现不在页面可观测范围内。 */
export const openDirectoryRequestedHint = '请到系统窗口中查看'
export const openDirectoryFailureInstruction = '请手动打开上面的路径'
export const openDirectoryUnsupportedInstruction = '请手动复制上面的路径'

export function openDirectoryFailureText(reason: string): string {
  const detail = reason.trim()
  return `${detail === '' ? '无法打开文件夹' : detail}；${openDirectoryFailureInstruction}`
}

export function openDirectoryUnsupportedText(reason: string): string {
  const detail = reason.trim()
  return `${detail === '' ? '当前环境不能打开本机目录' : detail}；${openDirectoryUnsupportedInstruction}`
}

type OpenDirectoryFeedback = {
  state: 'opened' | 'failed' | 'unsupported'
  message: string
}

interface SceneExportNoticeProps {
  notice: SceneExportNotice | null
  onDismiss: () => void
  /** 交给系统打开产物目录；成功时返回该次请求的提示语，缺省时只展示路径。 */
  onOpenDirectory?: (directoryPath: string) => Promise<string>
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
  onOpenDirectory?: (directoryPath: string) => Promise<string>
}

/** 每次导出提示变化都从头展示：旧的“打开中/失败”不带到新结果上。 */
function SceneExportNoticeContent({
  notice,
  onDismiss,
  onOpenDirectory
}: SceneExportNoticeContentProps): ReactElement {
  const [opening, setOpening] = useState(false)
  const [openFeedback, setOpenFeedback] = useState<OpenDirectoryFeedback | null>(null)

  const directoryPath = notice.tone === 'ok' ? (notice.directoryPath ?? null) : null
  const canDismiss = notice.tone !== 'busy'
  const title = notice.detail ?? notice.label
  const openUnsupported = openFeedback?.state === 'unsupported'

  const openDirectory = async (): Promise<void> => {
    if (opening || openUnsupported || directoryPath === null || onOpenDirectory === undefined) {
      return
    }
    setOpening(true)
    setOpenFeedback(null)
    try {
      const requestedMessage = await onOpenDirectory(directoryPath)
      const detail = requestedMessage.trim()
      setOpenFeedback({
        state: 'opened',
        message:
          detail === ''
            ? `已请求系统打开；${openDirectoryRequestedHint}`
            : `${detail}；${openDirectoryRequestedHint}`
      })
    } catch (error) {
      const failure = failureOf(error)
      setOpenFeedback(
        failure.code === ErrorCodes.forbidden
          ? { state: 'unsupported', message: openDirectoryUnsupportedText(failure.msg) }
          : { state: 'failed', message: openDirectoryFailureText(failure.msg) }
      )
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
        {openFeedback === null ? null : (
          <p
            className={styles.openFeedback}
            data-state={openFeedback.state}
            role={openFeedback.state === 'failed' ? 'alert' : undefined}
          >
            {openFeedback.state === 'opened' ? (
              <Check aria-hidden="true" />
            ) : openFeedback.state === 'failed' ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <Info aria-hidden="true" />
            )}
            <span>{openFeedback.message}</span>
          </p>
        )}
        {directoryPath === null || onOpenDirectory === undefined ? null : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.openAction}
              disabled={opening || openUnsupported}
              aria-busy={opening || undefined}
              onClick={() => void openDirectory()}
            >
              {opening ? (
                <Loader2 className={styles.spinner} aria-hidden="true" />
              ) : openUnsupported ? (
                <Info aria-hidden="true" />
              ) : (
                <FolderOpen aria-hidden="true" />
              )}
              <span>
                {opening ? '正在打开…' : openUnsupported ? '当前环境不能打开' : '打开所在文件夹'}
              </span>
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
