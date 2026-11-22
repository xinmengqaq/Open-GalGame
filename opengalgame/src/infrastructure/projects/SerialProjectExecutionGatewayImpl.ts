import type { ProjectExecutionGateway } from '@application/projects/ports/ProjectExecutionGateway'
export class SerialProjectExecutionGatewayImpl implements ProjectExecutionGateway {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  executeProjectOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('项目执行器正在关闭'))
    const result = this.tail.then(action)
    this.tail = result.catch(() => undefined)
    return result
  }

  async close(): Promise<void> {
    this.closing = true
    await this.tail
  }
}
