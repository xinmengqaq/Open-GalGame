import type { VersionContentSource, VersionSaveMode } from '../dto/ProjectVersioningDTO'
import type { VersionTarget } from '../models/VersionTarget'
import type { VersionBoundRetention } from './VersionContentGateway'

/**
 * 操作身份、基线和首次提交意图的持久绑定。
 * 记录本身不是作品已经提交的证明。
 */
export interface VersionOperationRecordGateway {
  /**
   * 持久绑定准备好的操作和基线。
   * 失败时调用方不得返回可用操作。
   * @throws {AppException} 绑定不能持久化。
   */
  bindPrepared(record: VersionPreparedRecord): Promise<void>

  /** 读取本工程中的原操作。不存在时返回 null，不代表事务未提交。 */
  read(projectId: string, operationId: string): Promise<VersionOperationRecord | null>

  /**
   * 持久绑定首次提交意图、内容指纹、历史身份和保留凭据。
   * 相同指纹重复绑定必须保持原来的 historyId。不同内容不得覆盖。
   * @throws {AppException} 绑定失败。调用方不得进入作品写入。
   */
  bindCommitIntent(
    projectId: string,
    operationId: string,
    intent: VersionCommitIntent
  ): Promise<void>

  /** 读取一个工程的操作绑定，供历史恢复和维护使用。 */
  listByProject(projectId: string): Promise<readonly VersionOperationRecord[]>

  /**
   * 替换意图上的凭据关联。
   * 只在释放成功后清空调据；失败时调用方保持原关联。
   */
  replaceRetentions(
    projectId: string,
    operationId: string,
    retentions: readonly VersionBoundRetention[]
  ): Promise<void>

  /**
   * 在提交前把调用方操作身份绑定到已准备的版本身份。
   * 同一调用方、工程、来源、目标和声明范围重复绑定必须返回原版本身份。
   * @throws {AppException} 绑定不能持久化，或同一调用方身份改绑工程、来源、目标或范围。
   */
  bindCallerOperation(binding: VersionCallerOperationBinding): Promise<void>

  /**
   * 按工程、来源和调用方身份读取已绑定的版本身份。
   * 不存在时返回 null，不代表事务未提交。
   */
  readCallerOperation(
    projectId: string,
    sourceModule: string,
    callerOperationId: string
  ): Promise<VersionCallerOperationLink | null>

  /**
   * 按来源和调用方身份读取绑定。调用方没有工程时使用。
   * 多条工程归属互相矛盾时失败，不能猜测。
   */
  findCallerOperation(
    sourceModule: string,
    callerOperationId: string
  ): Promise<VersionCallerOperationLink | null>
}

/** 尚未绑定提交意图的准备记录。 */
export type VersionPreparedRecord = {
  readonly projectId: string
  readonly operationId: string
  readonly sourceModule: string
  readonly targets: readonly VersionTarget[]
  readonly changePaths: readonly string[]
  readonly watchedPaths: readonly string[]
  readonly baselineRef: string
  readonly revisionRef: string
}

/** 首次写入前固定的内容指纹和用户历史元信息。 */
export type VersionCommitIntent = {
  readonly contentFingerprint: string
  readonly historyId: string
  readonly saveMode: VersionSaveMode
  readonly contentSource: VersionContentSource
  readonly title: string
  readonly summary: string
  readonly retentions: readonly VersionBoundRetention[]
}

/** 准备事实。提交意图为空表示还没有进入发布。 */
export type VersionOperationRecord = VersionPreparedRecord & {
  readonly commitIntent: VersionCommitIntent | null
}

/** 调用方操作身份与版本身份的持久关联。 */
export type VersionCallerOperationBinding = {
  readonly projectId: string
  readonly sourceModule: string
  readonly callerOperationId: string
  readonly operationId: string
  readonly targets: readonly VersionTarget[]
  readonly changePaths: readonly string[]
  readonly watchedPaths: readonly string[]
}

/** 已持久绑定的调用方关联。没有记录不表示可以重提。 */
export type VersionCallerOperationLink = {
  readonly projectId: string
  readonly sourceModule: string
  readonly callerOperationId: string
  readonly operationId: string
}
