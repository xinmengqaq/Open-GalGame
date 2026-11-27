import { useEffect, useRef, type ReactElement } from 'react'

import { Button } from '@presentation/components/Button'
import { DangerIcon } from '@presentation/components/DangerAction'
import { Dialog } from '@presentation/components/Dialog'
import type { AppearanceFlow } from './useAppearanceSettings'
import styles from './AppearanceSaveErrorDialog.module.css'

function isVisibleFocusTarget(node: Element | null): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    node.isConnected &&
    node.getClientRects().length > 0 &&
    !node.matches(':disabled')
  )
}

function resolveSettingsReturnFocus(): HTMLElement | null {
  const saveButton = document.querySelector<HTMLElement>('[data-appearance-save]')
  if (isVisibleFocusTarget(saveButton)) return saveButton
  const activeTab = document.querySelector<HTMLElement>(
    'dialog[open] [role="tab"][aria-selected="true"]'
  )
  if (isVisibleFocusTarget(activeTab)) return activeTab
  const opener = document.querySelector<HTMLElement>('[data-settings-opener]')
  if (isVisibleFocusTarget(opener)) return opener
  const heading = document.querySelector<HTMLElement>('h1, [role="heading"][aria-level="1"]')
  return isVisibleFocusTarget(heading) ? heading : null
}

/**
 * 需要用户处理的保存失败使用常驻弹窗，草稿留在设置中心，不把反馈嵌进表单布局。
 */
export function AppearanceSaveErrorDialog({ flow }: { flow: AppearanceFlow }): ReactElement {
  const failure = flow.saveFailure
  const ambiguous = failure?.ambiguous ?? false
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const isOpen = failure !== null
    if (!isOpen && wasOpenRef.current) {
      window.requestAnimationFrame(() => {
        const target = resolveSettingsReturnFocus()
        if (!target) return
        if (target.tagName === 'H1' && !target.hasAttribute('tabindex')) {
          target.setAttribute('tabindex', '-1')
        }
        target.focus({ preventScroll: true })
      })
    }
    wasOpenRef.current = isOpen
  }, [failure])

  return (
    <Dialog
      open={failure !== null}
      title={ambiguous ? '保存结果待确认' : '外观设置保存失败'}
      surface="glass"
      size="narrow"
      allowClose={!flow.saving}
      onClose={flow.dismissSaveFailure}
      actions={
        failure === null ? null : ambiguous ? (
          <>
            <Button
              variant="secondary"
              className={styles.safeAction}
              data-autofocus
              disabled={flow.saving}
              onClick={() => void flow.reloadAfterSaveConflict()}
            >
              重新读取
            </Button>
            <Button disabled={flow.saving || !flow.canSave} onClick={() => void flow.save()}>
              {flow.saving ? '保存中…' : '重试保存'}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              className={styles.safeAction}
              data-autofocus
              disabled={flow.saving}
              onClick={flow.dismissSaveFailure}
            >
              关闭
            </Button>
            <Button disabled={flow.saving || !flow.canSave} onClick={() => void flow.save()}>
              {flow.saving ? '保存中…' : '重试保存'}
            </Button>
          </>
        )
      }
    >
      {failure === null ? null : (
        <div className={styles.body}>
          <span className={styles.mark} aria-hidden="true">
            <DangerIcon />
          </span>
          <div className={styles.copy}>
            <p className={styles.message} role="alert">
              {failure.message}
            </p>
            <p className={styles.note}>
              {ambiguous
                ? '草稿已保留；这次写入结果尚未确认，不会自动重试。'
                : '草稿已保留，旧配置没有被替换；排除问题后可直接重试。'}
            </p>
          </div>
        </div>
      )}
    </Dialog>
  )
}
