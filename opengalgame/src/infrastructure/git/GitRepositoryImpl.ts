import { commitLimited } from './transaction/LimitedCommit'
import { realGitEffects, type GitEffects } from './gitEffects'
import type {
  GitRepository,
  LimitedCommitRequest,
  OperationCommitState,
  WorkBaseline
} from './GitRepository'
import { rollbackLimited } from './transaction/OperationRollback'
import { assessOperation } from './transaction/OperationQuery'
import { readWorkBaseline } from './repository/WorkBaseline'
import { enqueueWorkWrite } from './transaction/workWriteBoundary'

export class GitRepositoryImpl implements GitRepository {
  constructor(private readonly effects: GitEffects = realGitEffects) {}

  readBaseline(projectRoot: string, relativePaths: readonly string[]): Promise<WorkBaseline> {
    return readWorkBaseline(projectRoot, relativePaths)
  }

  commitChanges(request: LimitedCommitRequest): Promise<{ commitId: string }> {
    return enqueueWorkWrite(request.projectRoot, () => commitLimited(request, this.effects))
  }

  readOperation(projectRoot: string, operationId: string): Promise<OperationCommitState> {
    return assessOperation(projectRoot, operationId)
  }

  rollbackOperation(
    projectRoot: string,
    operationId: string
  ): Promise<{ rollbackCommitId: string }> {
    return enqueueWorkWrite(projectRoot, () =>
      rollbackLimited(projectRoot, operationId, this.effects)
    )
  }
}
