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

/** 作品仓库的技术实现。同一工程的提交和回退共用进程内短边界，不在候选生成期间持锁。 */
export class GitRepositoryImpl implements GitRepository {
  /**
   * @param effects - 文件与 Git 调用边界。默认使用本机实现；测试可在该边界注入失败。
   */
  constructor(private readonly effects: GitEffects = realGitEffects) {}

  readBaseline(projectRoot: string, relativePaths: readonly string[]): Promise<WorkBaseline> {
    return readWorkBaseline(projectRoot, relativePaths)
  }

  /** 限定路径提交。同一操作的可靠提交直接返回。 */
  commitChanges(request: LimitedCommitRequest): Promise<{ commitId: string }> {
    return enqueueWorkWrite(request.projectRoot, () => commitLimited(request, this.effects))
  }

  /** 按磁盘证据查询操作，不产生写入。 */
  readOperation(projectRoot: string, operationId: string): Promise<OperationCommitState> {
    return assessOperation(projectRoot, operationId)
  }

  /** 受控回退本操作的明确修改集。 */
  rollbackOperation(
    projectRoot: string,
    operationId: string
  ): Promise<{ rollbackCommitId: string }> {
    return enqueueWorkWrite(projectRoot, () =>
      rollbackLimited(projectRoot, operationId, this.effects)
    )
  }
}
