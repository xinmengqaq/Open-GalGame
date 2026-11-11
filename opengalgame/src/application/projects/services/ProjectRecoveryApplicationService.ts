export interface ProjectRecoveryApplicationService {
  /**
   * @returns 本次未能恢复的操作数量。
   */
  recoverIncompleteOperations(): Promise<number>
}
