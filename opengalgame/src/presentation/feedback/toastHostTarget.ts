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
