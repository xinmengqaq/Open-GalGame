import type {
  CheckForUpdateDTO,
  DownloadUpdateDTO,
  InstallUpdateDTO,
  ReadUpdateStatusDTO
} from '../dto/AppUpdateDTO'
import type { UpdateCheckVO, UpdateStatusVO } from '../vo/AppUpdateVO'

export interface AppUpdateApplicationService {
  /**
   * 检查发布源。只有严格新版本进入 available；最新或更旧版本回到 idle。
   * @throws {AppException} 并发检查、运行形态不支持或发布源不可用。
   */
  checkForUpdate(request: CheckForUpdateDTO): Promise<UpdateCheckVO>

  /**
   * 启动已确认更新的后台下载，立即返回 downloading 状态。
   * @throws {AppException} 并发操作或尚未确认可下载的更新。
   */
  downloadUpdate(request: DownloadUpdateDTO): Promise<UpdateStatusVO>

  /**
   * 记录安装尝试并在下一事件循环退出安装。
   * @throws {AppException} 并发操作、尚未下载或安装记录无法写入。
   */
  installUpdate(request: InstallUpdateDTO): Promise<void>

  /** 读取当前更新状态。 */
  readStatus(request: ReadUpdateStatusDTO): Promise<UpdateStatusVO>

  /**
   * 订阅状态变化。
   * @returns 退订方法；重复调用安全。
   */
  subscribe(listener: (status: UpdateStatusVO) => void): () => void
}
