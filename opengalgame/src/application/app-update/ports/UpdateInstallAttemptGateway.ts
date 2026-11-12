import type { UpdateInstallAttempt } from '@domain/app-update/models/InstallAttempt'

/** 跨启动保存最近一次已启动的更新安装。 */
export interface UpdateInstallAttemptGateway {
  /** @returns 最近一次安装尝试；没有记录或已清理时为 null。 */
  read(): Promise<UpdateInstallAttempt | null>

  /** 原子记录安装尝试。 */
  record(attempt: UpdateInstallAttempt): Promise<void>

  /** 清理安装尝试。文件不存在时不做事。 */
  clear(): Promise<void>
}
