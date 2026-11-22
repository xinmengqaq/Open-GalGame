export interface ProjectRecoveryApplicationService {
  recoverIncompleteOperations(): Promise<number>
}
