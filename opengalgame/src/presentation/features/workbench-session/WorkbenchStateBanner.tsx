import { clsx } from 'clsx'
import { useRef, type ReactElement } from 'react'

import { useWorkbenchState } from './workbenchState'
import { useWorkbenchStateMotion } from './useWorkbenchStateMotion'
import styles from './WorkbenchStateBanner.module.css'

interface WorkbenchStateBannerProps {
  className?: string
}

/**
 * 顶栏全局状态视图。用一条轻量状态轨标出当前报告的是工程、来源目录还是画布编排，
 * 再输出对象、状态与下一步；失败和损坏的标题、色调和下一步不同，
 * 不再用绿色“工程已读取”覆盖失败事实。
 */
export function WorkbenchStateBanner({ className }: WorkbenchStateBannerProps): ReactElement {
  const state = useWorkbenchState()
  const root = useRef<HTMLDivElement>(null)
  useWorkbenchStateMotion(root, `${state.kind}:${state.scope}:${state.failureCode ?? 0}`)

  return (
    <div
      ref={root}
      className={clsx(styles.banner, className)}
      data-kind={state.kind}
      data-scope={state.scope}
      data-tone={state.tone}
      data-testid="workbench-state-banner"
      role="status"
      aria-live="polite"
    >
      <span className={styles.track} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle className={styles.trackRail} cx="12" cy="12" r="8.4" />
          <circle
            className={styles.trackPart}
            data-part="catalog"
            cx="12"
            cy="12"
            r="8.4"
            pathLength={100}
            strokeDasharray="22 78"
            transform="rotate(-90 12 12)"
          />
          <circle
            className={styles.trackPart}
            data-part="arrangement"
            cx="12"
            cy="12"
            r="8.4"
            pathLength={100}
            strokeDasharray="22 78"
            transform="rotate(30 12 12)"
          />
        </svg>
        <span className={styles.trackCore} />
      </span>
      <span className={styles.copy}>
        {state.kind !== 'ready' ? <span className={styles.subject}>{state.subject}</span> : null}
        <strong className={styles.title}>{state.title}</strong>
        {state.kind !== 'ready' ? <span className={styles.next}>{state.nextStep}</span> : null}
      </span>
    </div>
  )
}
