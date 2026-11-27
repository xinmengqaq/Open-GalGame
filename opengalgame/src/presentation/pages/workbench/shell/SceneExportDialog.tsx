import { Check, CircleAlert, Clapperboard, FolderOpen, HardDrive, Loader2 } from 'lucide-react'
import { useId, type ReactElement } from 'react'

import { Button } from '@presentation/components/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '@presentation/components/ui/dialog'
import theme from '@presentation/pages/workbench/workbenchTheme.module.css'

import type { WorkbenchExportDestinationDialog } from './useWorkbenchExportController'
import styles from './SceneExportDialog.module.css'

export interface SceneExportDialogProps extends WorkbenchExportDestinationDialog {
  /** 导出源的真实工程与场景身份；不展示路径或版本号。 */
  readonly projectName?: string
  readonly sceneLabel?: string
}

/**
 * 两个导出入口共用的目的地弹窗。
 * 默认选中工程目录；显式选择只调用主进程文件夹选择器，取消选择器不关闭弹窗、不写盘。
 * 使用 Radix Dialog 而不是原生 `<dialog>`：它可以从已打开的创作抽屉上方正常显示，
 * 并由 Radix 统一维护 aria-hidden 与焦点，不把选址做成聊天气泡。
 *
 * 选择器状态与选择结果放在操作栏的浮动提示位：不新增正文行、不改变操作栏高度，
 * 弹窗主体和两个按钮的位置只随常驻选项变化，不随临时反馈跳动。
 */
export function SceneExportDialog({
  open,
  mode,
  selection,
  choosing,
  error,
  selectMode,
  choose,
  confirm,
  close,
  projectName,
  sceneLabel
}: SceneExportDialogProps): ReactElement {
  const missingSelection = mode === 'selected' && selection === null
  const feedbackId = useId()
  const feedback = dialogFeedbackOf({
    mode,
    selection,
    choosing,
    error
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !choosing) close()
      }}
    >
      <DialogContent
        className={`${theme.theme} ${styles.dialog}`}
        aria-describedby="scene-export-description"
        aria-busy={choosing || undefined}
        onEscapeKeyDown={(event) => {
          if (choosing) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (choosing) event.preventDefault()
        }}
      >
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <DialogTitle className={styles.title}>导出当前场景</DialogTitle>
            <DialogDescription id="scene-export-description" className={styles.subtitle}>
              导出已保存的当前场景为 Windows 游戏
            </DialogDescription>
          </div>
        </header>
        <div className={styles.body}>
          <div className={styles.source}>
            <span aria-hidden="true" className={styles.sourceArt}>
              <Clapperboard />
            </span>
            <span className={styles.sourceCopy}>
              <span className={styles.sourceLabel}>导出源</span>
              <strong>{projectName || '当前工程'}</strong>
              <span className={styles.sourceScene}>{sceneLabel || '当前场景'}</span>
            </span>
            <span className={styles.sourceState}>
              <Check aria-hidden="true" />
              已保存版本
            </span>
          </div>
          <fieldset className={styles.options}>
            <legend className={styles.legend}>导出位置</legend>
            <label className={styles.option} data-selected={mode === 'workspace'}>
              <input
                type="radio"
                name="scene-export-destination"
                value="workspace"
                checked={mode === 'workspace'}
                onChange={() => selectMode('workspace')}
              />
              <span className={styles.optionIcon} aria-hidden="true">
                <HardDrive />
              </span>
              <span className={styles.optionCopy}>
                <strong>工程目录（默认）</strong>
                <span>在当前工程的 exports 文件夹下新建场景文件夹，不写入游戏内容。</span>
              </span>
            </label>
            <label className={styles.option} data-selected={mode === 'selected'}>
              <input
                type="radio"
                name="scene-export-destination"
                value="selected"
                checked={mode === 'selected'}
                onChange={() => selectMode('selected')}
              />
              <span className={styles.optionIcon} aria-hidden="true">
                <FolderOpen />
              </span>
              <span className={styles.optionCopy}>
                <strong>其他位置</strong>
                <span>选择一个文件夹作为父目录，在其下新建场景文件夹。</span>
              </span>
            </label>
          </fieldset>
          {mode === 'selected' ? (
            <div className={styles.picker}>
              <Button
                variant="secondary"
                data-testid="scene-export-choose"
                onClick={choose}
                disabled={choosing}
              >
                {choosing ? '正在选择…' : selection === null ? '选择文件夹' : '更改文件夹'}
              </Button>
            </div>
          ) : null}
        </div>
        <footer className={styles.actions}>
          {feedback === null ? null : (
            <div
              id={feedbackId}
              className={styles.dialogFeedback}
              data-tone={feedback.tone}
              role={feedback.tone === 'danger' ? 'alert' : 'status'}
              aria-live={feedback.tone === 'danger' ? 'assertive' : 'polite'}
              title={feedback.text}
            >
              <span className={styles.feedbackIcon} aria-hidden="true">
                {feedback.tone === 'busy' ? (
                  <Loader2 className={styles.feedbackSpinner} />
                ) : feedback.tone === 'danger' ? (
                  <CircleAlert />
                ) : null}
              </span>
              <span className={styles.feedbackText}>{feedback.text}</span>
            </div>
          )}
          <Button variant="secondary" onClick={close} disabled={choosing}>
            取消
          </Button>
          <Button
            data-guide-target="export-confirm"
            onClick={confirm}
            disabled={choosing || missingSelection}
            aria-describedby={feedback === null ? undefined : feedbackId}
          >
            开始导出
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

interface DialogFeedback {
  tone: 'info' | 'busy' | 'danger'
  text: string
}

interface DialogFeedbackInput {
  mode: WorkbenchExportDestinationDialog['mode']
  selection: WorkbenchExportDestinationDialog['selection']
  choosing: boolean
  error: string | null
}

/** 选择器的临时状态只走一条浮动提示；正文只保留常驻选项和选择按钮。 */
function dialogFeedbackOf({
  mode,
  selection,
  choosing,
  error
}: DialogFeedbackInput): DialogFeedback | null {
  if (error !== null) return { tone: 'danger', text: error }
  if (choosing) return { tone: 'busy', text: '正在打开系统文件夹选择器…' }
  if (mode !== 'selected') return null
  if (selection === null) return { tone: 'info', text: '尚未选择文件夹' }
  return { tone: 'info', text: `已选择父目录：${selection.directoryPath}` }
}
