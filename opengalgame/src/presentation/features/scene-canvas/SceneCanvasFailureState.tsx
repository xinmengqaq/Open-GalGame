import { useRef, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import type { FailureState } from '../../feedback/failure'
import { arrangementStateOf } from '../workbench-session/workbenchState'
import { useSceneCanvasFailureMotion } from './useSceneCanvasFailureMotion'
import styles from './SceneCanvasFailureState.module.css'

interface SceneCanvasFailureStateProps {
  error: FailureState
  onInspect: () => void
  onReload: () => void
}

/**
 * 已保存画布读取失败或编排损坏。入口保持兼容，状态标题、图标、色调和动作
 * 全部由统一 WorkbenchState 映射；读取失败可重试，损坏只把检查工程作为下一步。
 */
export function SceneCanvasFailureState({
  error,
  onInspect,
  onReload
}: SceneCanvasFailureStateProps): ReactElement {
  const state = arrangementStateOf('failed', error)
  const root = useRef<HTMLDivElement>(null)
  useSceneCanvasFailureMotion(root, `${state.kind}:${state.failureCode ?? 0}`)
  const damaged = state.kind === 'damaged'
  const actionHandlers = {
    inspect: onInspect,
    reload: onReload
  } as const

  return (
    <div
      ref={root}
      className={styles.surface}
      data-kind={state.kind}
      data-tone={state.tone}
      data-code={state.failureCode ?? undefined}
      data-testid="canvas-failed"
    >
      <span className={styles.halo} data-motion="failure-halo" aria-hidden="true" />
      <div className={styles.composition} data-motion="failure-card">
        <span className={styles.orb} data-motion="failure-seal" aria-hidden="true">
          {damaged ? <DamagedArt /> : <FailedArt />}
        </span>
        <header className={styles.head}>
          <p className={styles.eyebrow}>画布状态 · {damaged ? '编排损坏' : '读取失败'}</p>
          <h2 data-motion="failure-reveal">{state.title}</h2>
        </header>

        {state.detail ? (
          <p className={styles.detail} data-motion="failure-reveal">
            {state.detail}
          </p>
        ) : null}

        <p className={styles.next} data-motion="failure-reveal">
          <span className={styles.nextLabel}>下一步</span>
          <span>{state.nextStep}</span>
        </p>

        <p className={styles.policy} data-motion="failure-reveal">
          {damaged
            ? '损坏内容不会被自动覆盖或自动修复；请先检查工程，再决定恢复范围。'
            : '读取失败不会被当作空画布，也不会自动改写工程内容。'}
        </p>

        <div className={styles.actions} data-motion="failure-reveal">
          {state.actions.map((action) => (
            <span
              key={action.intent}
              className={styles.actionSlot}
              data-motion={action.intent === 'reload' ? 'retry-action' : 'state-action'}
            >
              <Button
                variant={action.emphasis === 'primary' ? 'primary' : 'secondary'}
                onClick={actionHandlers[action.intent]}
              >
                {action.intent === 'reload' ? <ReloadArt /> : <InspectArt />}
                {action.label}
              </Button>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function FailedArt(): ReactElement {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M7 4.8h12.2L26 11.5v14.3a1.7 1.7 0 0 1-1.7 1.7H7a1.7 1.7 0 0 1-1.7-1.7V6.5A1.7 1.7 0 0 1 7 4.8Z" />
      <path d="M19 4.9v7h7" />
      <path d="M10.6 16.1h6.5M10.6 20.3h3.8" />
      <path d="m22.2 19.1 3.4 3.4m0-3.4-3.4 3.4" />
    </svg>
  )
}

function DamagedArt(): ReactElement {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M6.2 7.3 25.3 5l1.5 19.3-19.1 1.9Z" />
      <path d="m16.4 5.4-1.2 7.4 3.3 2.7-2.3 3.2 1 6.4" />
      <path d="m7.8 23.6 4.4-4.3M19.1 28.2l2.1-3.9" />
    </svg>
  )
}

function InspectArt(): ReactElement {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="10.6" cy="10.6" r="5.8" />
      <path d="m15 15 4.6 4.6" />
      <path d="M8.7 10.6h3.8" />
    </svg>
  )
}

function ReloadArt(): ReactElement {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1" />
      <path d="M19.4 4.9v4.4H15" />
    </svg>
  )
}
