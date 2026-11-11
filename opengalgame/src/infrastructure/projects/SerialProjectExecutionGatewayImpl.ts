import type { ProjectExecutionGateway } from '@application/projects/ports/ProjectExecutionGateway'
export class SerialProjectExecutionGatewayImpl implements ProjectExecutionGateway {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  /** 排队执行，失败不阻塞后续独立操作。 */
  executeProjectOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('项目执行器正在关闭'))
    const result = this.tail.then(action)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** 停止接收新操作并等待当前提交结束。 @returns 队列排空。 */
  async close(): Promise<void> {
    this.closing = true
    await this.tail
  }
}
