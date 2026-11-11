import type { ImmutableCandidateInputDTO, FileChangesInputDTO } from '../dto/ProjectVersioningDTO'

/**
 * 来源内容的持久保留边界。
 * 凭据不透明；候选位置、对象标识和读取方式不进入应用层。
 */
export interface VersionContentGateway {
  /**
   * 为原操作取得可重启核对的保留凭据。
   * 同一操作和同一内容指纹重复调用必须返回原凭据。删除项没有凭据。
   * 这里只保留来源内容，不发布作品。
   * @throws {AppException} 内容身份不能固定或与已保留的指纹冲突。
   */
  retain(input: VersionRetainRequest): Promise<readonly VersionBoundRetention[]>

  /**
   * 幂等释放原操作的来源保留。
   * 不删除作品修订、回退证据或来源模块仍在使用的候选。
   * @throws {AppException} 本次释放没有完成。调用方保留关联并稍后重试。
   */
  release(input: VersionReleaseRequest): Promise<void>
}

/** 绑定在操作上的一条路径凭据。 */
export type VersionBoundRetention = {
  readonly relativePath: string
  readonly action: 'add' | 'modify' | 'delete'
  readonly retentionRef: string | null
}

export type VersionRetainRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly fingerprint: string
  readonly input: FileChangesInputDTO | ImmutableCandidateInputDTO
}

export type VersionReleaseRequest = {
  readonly projectId: string
  readonly operationId: string
  readonly retentionRefs: readonly string[]
}
