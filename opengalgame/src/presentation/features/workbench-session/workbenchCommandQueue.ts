export interface WorkbenchCommandQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>
  idle(): Promise<void>
}

export function createWorkbenchCommandQueue(): WorkbenchCommandQueue {
  let queue: Promise<void> = Promise.resolve()

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = queue.then(task, task)
      queue = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
    idle(): Promise<void> {
      return queue
    }
  }
}
