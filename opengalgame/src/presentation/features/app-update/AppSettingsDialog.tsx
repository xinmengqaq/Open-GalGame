import type { ReactElement } from 'react'

import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { ErrorIcon } from '../../components/Icons'
import { AppUpdateSection, ManualDownloadLink } from './AppUpdateSection'
import styles from './AppSettingsDialog.module.css'
import type { AppUpdateFlow } from './useAppUpdate'

/** 首页入口的常驻应用设置对话框；开关只改变可见性，不清主进程更新状态。 */
export function AppSettingsDialog({ flow }: { flow: AppUpdateFlow }): ReactElement {
  return (
    <Dialog
      open={flow.settingsOpen}
      title="应用设置"
      subtitle="版本与更新"
      size="wide"
      allowClose
      onClose={flow.closeSettings}
      actions={
        <Button variant="secondary" onClick={flow.closeSettings}>
          关闭
        </Button>
      }
    >
      <AppUpdateSection flow={flow} />
    </Dialog>
  )
}

/** 更新失败提示：只展示主进程映射过的安全文案，关闭不改变主进程状态。 */
export function AppUpdateErrorDialog({ flow }: { flow: AppUpdateFlow }): ReactElement {
  const error = flow.error
  return (
    <Dialog
      open={error !== null}
      title={error?.title ?? '更新失败'}
      size="narrow"
      allowClose
      onClose={flow.dismissError}
      actions={
        error === null ? null : (
          <>
            <Button variant="secondary" onClick={flow.dismissError}>
              关闭
            </Button>
            {error.retryable ? <Button onClick={() => void flow.retry()}>重试</Button> : null}
          </>
        )
      }
    >
      {error === null ? null : (
        <div className={styles.errorBody} role="alert">
          <div className={styles.errorLead}>
            <span className={styles.errorMark} aria-hidden="true">
              <ErrorIcon />
            </span>
            <p className={styles.errorMessage}>{error.message}</p>
          </div>
          {error.showManualDownload ? (
            <ManualDownloadLink className={styles.errorDownload} />
          ) : null}
          <p className={styles.errorHint}>更新操作不会改动你的工程与本地文件。</p>
        </div>
      )}
    </Dialog>
  )
}
