export interface ProjectExecutionGateway {
  executeProjectOperation<T>(action: () => Promise<T>): Promise<T>
}
