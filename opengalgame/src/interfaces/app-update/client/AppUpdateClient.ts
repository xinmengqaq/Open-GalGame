import type {
  CheckForUpdateDTO,
  DownloadUpdateDTO,
  InstallUpdateDTO,
  ReadUpdateStatusDTO
} from '@application/app-update/dto/AppUpdateDTO'
import type { UpdateCheckVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface AppUpdateClient {
  checkForUpdate(request: CheckForUpdateDTO): Promise<AjaxResult<UpdateCheckVO>>
  downloadUpdate(request: DownloadUpdateDTO): Promise<AjaxResult<UpdateStatusVO>>
  installUpdate(request: InstallUpdateDTO): Promise<AjaxResult<null>>
  readUpdateStatus(request: ReadUpdateStatusDTO): Promise<AjaxResult<UpdateStatusVO>>
  /**
   * 订阅主进程推送的更新状态。
   * @returns 退订方法；重复调用安全。
   */
  onStatus(listener: (status: UpdateStatusVO) => void): () => void
}
