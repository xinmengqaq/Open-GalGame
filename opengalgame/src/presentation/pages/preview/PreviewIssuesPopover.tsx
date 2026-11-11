import { X } from 'lucide-react'
import { useEffect, useRef, type ReactElement, type RefObject } from 'react'

import type {
  SceneDialogueVO,
  ScenePreviewIssueVO
} from '@application/scene-preview/vo/ScenePreviewSessionVO'

import { dialogueNumber, previewIssueList } from './previewPresentation'
import styles from './PreviewIssuesPopover.module.css'

interface PreviewIssuesPopoverProps {
  readonly issues: readonly ScenePreviewIssueVO[]
  readonly dialogues: readonly SceneDialogueVO[]
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly onSelectDialogue: (dialogueId: string) => void
}

/** 读取提示按需展开；提示不阻断保存，也不进入主布局。 */
export function PreviewIssuesPopover({
  issues,
  dialogues,
  anchorRef,
  onClose,
  onSelectDialogue
}: PreviewIssuesPopoverProps): ReactElement {
  const popoverRef = useRef<HTMLDivElement>(null)
  const items = previewIssueList(issues)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
      anchorRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [anchorRef, onClose])

  return (
    <div ref={popoverRef} className={styles.popover} role="dialog" aria-label="预览提示">
      <header className={styles.head}>
        <div>
          <p className={styles.kicker}>预览提示</p>
          <h2>{issues.length} 处内容可能看不全</h2>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="关闭提示">
          <X size={15} strokeWidth={2} />
        </button>
      </header>
      <ul className={styles.list}>
        {items.map((item) => {
          const dialogueId = item.dialogueId
          const number = dialogueId === undefined ? null : dialogueNumber(dialogues, dialogueId)
          return (
            <li key={item.key} className={styles.item}>
              <div className={styles.itemText}>
                <span className={styles.itemLabel}>{item.label}</span>
                <p>{item.message}</p>
              </div>
              {dialogueId !== undefined ? (
                <button
                  type="button"
                  className={styles.jump}
                  onClick={() => {
                    onSelectDialogue(dialogueId)
                    onClose()
                  }}
                >
                  {number === null ? '定位' : `第 ${number} 句`}
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className={styles.foot}>提示只说明这部分可能无法完整预览，不影响保存。</p>
    </div>
  )
}
