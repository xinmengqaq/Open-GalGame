import type { ReactElement } from 'react'

import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { ErrorIcon } from '../../components/Icons'
import { ManualDownloadLink } from './AppUpdateSection'
import styles from './AppSettingsDialog.module.css'
import type { AppUpdateFlow } from './useAppUpdate'

export function AppUpdateErrorDialog({ flow }: { flow: AppUpdateFlow }): ReactElement {
  const error = flow.error
  return (
    <Dialog
      open={error !== null}
      title={error?.title ?? '更新失败'}
      surface="glass"
      size="narrow"
      allowClose
      onClose={flow.dismissError}
      actions={
        error === null ? null : (
          <>
            <Button
              variant="secondary"
              className={styles.safeAction}
              data-autofocus
              onClick={flow.dismissError}
            >
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
        </div>
      )}
    </Dialog>
  )
}
