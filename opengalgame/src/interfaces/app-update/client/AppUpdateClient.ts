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
  onStatus(listener: (status: UpdateStatusVO) => void): () => void
}
