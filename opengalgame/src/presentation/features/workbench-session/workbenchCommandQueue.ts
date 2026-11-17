/**
 * 工作台命令串行队列。后续任务总排在当前链尾，失败任务不会阻断队列：
 * 链尾始终收敛为已结算 Promise，`idle` 只等待调用时已排队的任务。
 */
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
