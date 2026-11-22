import { Info, X } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import styles from './GenerationStartNotice.module.css'

interface GenerationStartNoticeProps {
  readonly notice: string | null
  /** 工作台反馈层已注册的持久通知槽位；toast 槽位留给其它动作的瞬时结果。 */
  readonly slot: HTMLElement | null
}

/**
 * 已派发启动结果的页级提示。挂在当前生成面板之外，写入工作台反馈层已有的
 * 持久通知槽位：历史标签打开、生成面板隐藏或随后切视图时仍可阅读。
 * 不占用 sonner toast 槽位，也不与其它动作的结果共用 id；分叉等结果出现时
 * 只会让各自槽位垂直排列，不靠后出现或更高层级压盖。未知结果只按原文呈现。
 */
export function GenerationStartNotice({
  notice,
  slot
}: GenerationStartNoticeProps): ReactElement | null {
  if (notice === null || slot === null) return null
  return createPortal(<GenerationStartNoticeContent key={notice} notice={notice} />, slot)
}

function GenerationStartNoticeContent({ notice }: { notice: string }): ReactElement | null {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  return (
    <aside
      className={styles.notice}
      data-testid="generation-start-notice"
      role="status"
      aria-live="polite"
      title={notice}
    >
      <span className={styles.signal} aria-hidden="true">
        <Info />
      </span>
      <div className={styles.content}>
        <p className={styles.label}>启动结果</p>
        <p className={styles.message}>{notice}</p>
      </div>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="关闭启动结果提示"
        title="关闭"
        onClick={() => setDismissed(true)}
      >
        <X aria-hidden="true" />
      </button>
    </aside>
  )
}
