/**
 * 作品仓库上的短事务事实。
 * 不暴露 Git 阶段、命令或磁盘位置；查询失败必须抛出，不能用空结果表示。
 */
export interface VersionTransactionGateway {
  /**
   * 显式建立或核对作品仓库和首个基线。
   * 已有仓库保留原历史，不重建、不重置。
   * @throws {AppException} 工程不可用或声明范围不能建立基线。
   */
  initializeBaseline(input: InitializeBaselineRequest): Promise<VersionBaselineFact>

  /**
   * 没有基线时建立首个基线；已有基线时只提交其中尚不存在的声明路径。
   * 不重置历史，不覆盖已有文件，没有新增路径时不提交。
   * @throws {AppException} 工程不可用、路径不合法或声明路径不能纳入基线。
   */
  ensureDeclaredPaths(input: EnsureDeclaredPathsRequest): Promise<VersionBaselineFact>

  /**
   * 读取当前可靠基线。
   * 返回 null 只表示已经确认没有基线，准备操作不得因此创建仓库。
   * @throws {AppException} 仓库无法读取。
   */
  readBaseline(projectId: string): Promise<VersionBaselineFact | null>

  /**
   * 确认声明路径都在当前基线中。
   * 返回 false 表示没有仓库、没有基线，或路径尚未纳入。不创建仓库，不提交。
   * @throws {AppException} 路径不合法或工程不可用。
   */
  inspectDeclaredPaths(input: EnsureDeclaredPathsRequest): Promise<boolean>

  /**
   * 读取一个操作已经核实的事务证据。
   * 返回 null 只表示已经确认没有该操作的事务；结果不明必须用「待核对」，不能返回 null。
   * @throws {AppException} 证据无法读取。
   */
  readTransaction(projectId: string, operationId: string): Promise<VersionTransactionView | null>

  /**
   * 在短写入边界内先执行 verify，再发布已经核对的限定变更。
   * verify 抛出或返回 reuse 时不得发布。不得 reset、改写已有提交或强制覆盖。
   * 技术补偿留在实现内部。无变更也要形成可再次读取的可靠版本。
   * @throws {AppException} 发布前的确定失败。无法判断是否发布时返回待核对，不抛成功。
   */
  commit(input: VersionCommitRequest): Promise<VersionCommitExecution>

  /**
   * 在短写入边界内追加一条回退提交，只覆盖本次拥有的路径。
   * 不得重置分支或改写原提交。verify 拒绝时不得追加。
   * @throws {AppException} 回退前的确定失败。结果不明时返回待核对。
   */
  rollback(input: VersionRollbackRequest): Promise<VersionRollbackExecution>
}

/** 基线身份和它指向的作品修订。 */
export type VersionBaselineFact = {
  readonly baselineRef: string
  readonly revisionRef: string
}

/** 一次操作的事务证据。修订字段随状态出现，待核对不带修订。 */
export type VersionTransactionView = {
  readonly operationId: string
  readonly contentFingerprint: string
  readonly outcome: VersionTransactionOutcome
}

/** 事务端口能够证明的协议结果。 */
export type VersionTransactionOutcome =
  | {
      readonly state: '已提交'
      readonly revisionRef: string
      readonly changedAt: string
    }
  | {
      readonly state: '无变更'
      readonly revisionRef: string
      readonly changedAt: string
    }
  | { readonly state: '未提交' }
  | {
      readonly state: '待回退'
      readonly revisionRef: string
      readonly changedAt: string
    }
  | {
      readonly state: '已回退'
      readonly originalRevisionRef: string
      readonly revisionRef: string
      readonly changedAt: string
    }
  | { readonly state: '待核对' }

/** 提交边界内重新观察到的基线和事务。 */
export type VersionCommitObservation = {
  readonly baseline: VersionBaselineFact
  /** 范围内已偏离基线、且与本次声明内容不一致的路径。已落盘且字节一致的声明路径不算。 */
  readonly subsequentPaths: readonly string[]
  readonly transaction: VersionTransactionView | null
}

/** 回退边界内重新观察到的原事务和后续改动。 */
export type VersionRollbackObservation = {
  readonly subsequentPaths: readonly string[]
  readonly transaction: VersionTransactionView | null
}

/** verify 通过后才可以发布；reuse 表示边界内已经存在可靠结果。 */
export type VersionBoundaryDecision = { readonly action: 'publish' } | { readonly action: 'reuse' }

/** 交给事务发布的限定变更。删除没有内容凭据。 */
export type VersionLimitedChange = {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly retentionRef: string | null
}

export type InitializeBaselineRequest = {
  readonly projectId: string
  readonly initialPaths: readonly string[]
}

/** 纳入首个基线，或只补已有基线中缺失的声明路径。 */
export type EnsureDeclaredPathsRequest = {
  readonly projectId: string
  readonly paths: readonly string[]
}

export type VersionCommitRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly baselineRef: string
  readonly contentFingerprint: string
  readonly changes: readonly VersionLimitedChange[]
  readonly verify: (observation: VersionCommitObservation) => Promise<VersionBoundaryDecision>
}

/** 事务发布后的可靠结果，或无法证明的待核对。 */
export type VersionCommitExecution =
  | { readonly state: '已提交'; readonly revisionRef: string; readonly changedAt: string }
  | { readonly state: '无变更'; readonly revisionRef: string; readonly changedAt: string }
  | { readonly state: '待核对' }

export type VersionRollbackRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly ownedPaths: readonly string[]
  readonly verify: (observation: VersionRollbackObservation) => Promise<VersionBoundaryDecision>
}

/** 追加回退后的可靠结果，或无法证明的待核对。 */
export type VersionRollbackExecution =
  | {
      readonly state: '已回退'
      readonly originalRevisionRef: string
      readonly revisionRef: string
      readonly changedAt: string
    }
  | { readonly state: '待核对' }
