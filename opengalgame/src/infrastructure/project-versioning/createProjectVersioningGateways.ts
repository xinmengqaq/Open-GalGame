import type { VersionContentGateway } from '@application/project-versioning/ports/VersionContentGateway'
import type { VersionHistoryGateway } from '@application/project-versioning/ports/VersionHistoryGateway'
import type { VersionOperationRecordGateway } from '@application/project-versioning/ports/VersionOperationRecordGateway'
import type { VersionTransactionGateway } from '@application/project-versioning/ports/VersionTransactionGateway'
import { realGitEffects, type GitEffects } from '@infrastructure/git/gitEffects'

import { FileVersionContentGateway } from './FileVersionContentGateway'
import { FileVersionHistoryGateway } from './FileVersionHistoryGateway'
import { FileVersionOperationRecordGateway } from './FileVersionOperationRecordGateway'
import { GitVersionTransactionGateway } from './GitVersionTransactionGateway'

/** 四个端口共用登记目录和可选的 Git 故障边界。 */
export function createProjectVersioningGateways(
  userDirectory: string,
  effects: GitEffects = realGitEffects
): {
  transactions: VersionTransactionGateway
  records: VersionOperationRecordGateway
  content: VersionContentGateway
  history: VersionHistoryGateway
} {
  return {
    transactions: new GitVersionTransactionGateway(userDirectory, effects),
    records: new FileVersionOperationRecordGateway(userDirectory),
    content: new FileVersionContentGateway(userDirectory),
    history: new FileVersionHistoryGateway(userDirectory)
  }
}
