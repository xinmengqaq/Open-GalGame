import type { UpdateInstallAttempt } from '@domain/app-update/models/InstallAttempt'

export interface UpdateInstallAttemptGateway {
  read(): Promise<UpdateInstallAttempt | null>

  record(attempt: UpdateInstallAttempt): Promise<void>

  clear(): Promise<void>
}
