/**
 * 全局只有一个 ToastHost；工作台壳层挂载时登记自己的反馈槽位，
 * 让既有 toast store 调用落在壳层安全区里，离开工作台后回到应用默认位置。
 */
let target: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setFeedbackToastTarget(next: HTMLElement | null): void {
  if (target === next) return
  target = next
  for (const listener of listeners) listener()
}

export function subscribeFeedbackToastTarget(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function feedbackToastTarget(): HTMLElement | null {
  return target
}
