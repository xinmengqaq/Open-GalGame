export interface ContentPresence {
  readonly exists: boolean
  readonly digest: string | null
}

export interface WorkPathState {
  readonly relativePath: string
  readonly head: ContentPresence
  readonly stage: ContentPresence
  readonly worktree: ContentPresence
}

export interface WorkBaseline {
  readonly headCommitId: string
  readonly branch: string | null
  readonly paths: readonly WorkPathState[]
}

export interface WorkPathChange {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
}

export interface CandidateRevisionRef {
  readonly gitDir: string
  readonly revisionId: string
}

export interface LimitedCommitRequest {
  readonly projectRoot: string
  readonly operationId: string
  readonly expectedBaseline: WorkBaseline
  readonly changes: readonly WorkPathChange[]
  readonly candidate: CandidateRevisionRef
  readonly recheck: (baseline: WorkBaseline) => void | Promise<void>
}

export type OperationCommitState =
  | { readonly state: 'notCommitted' }
  | { readonly state: 'committed'; readonly commitId: string }
  | { readonly state: 'rollbackRequired'; readonly commitId: string }
  | { readonly state: 'rolledBack'; readonly commitId: string; readonly rollbackCommitId: string }
  | { readonly state: 'unknown'; readonly detail: string }

/** 作品 Git 的基础设施技术契约。只描述仓库读写，不决定业务是否覆盖。 */
export interface GitRepository {
  /**
   * 只读读取 HEAD、分支和指定路径在提交、暂存区、工作区中的摘要。
   * @throws {AppException} 仓库不存在、没有提交或读取失败。
   */
  readBaseline(projectRoot: string, relativePaths: readonly string[]): Promise<WorkBaseline>

  /**
   * 在短边界内复核基线、候选修订和调用方检查，再按路径集合发布一次提交。
   * @returns 已发布或原有的可靠提交。
   * @throws {AppException} 基线变化、内容冲突、结果不明或提交失败。
   */
  commitChanges(request: LimitedCommitRequest): Promise<{ commitId: string }>

  /**
   * 交叉核对操作记录、引用、历史和真实文件。不写入、不清理、不重提。
   * @returns 未提交、已提交、需要回退、已回退或结果不明。
   * @throws {AppException} 核对过程本身无法读取仓库。
   */
  readOperation(projectRoot: string, operationId: string): Promise<OperationCommitState>

  /**
   * 在当前历史之后追加提交，只恢复本操作记录中的路径。
   * @returns 新的回退提交。
   * @throws {AppException} 目标路径已有后续改动，或回退失败。
   */
  rollbackOperation(projectRoot: string, operationId: string): Promise<{ rollbackCommitId: string }>
}
