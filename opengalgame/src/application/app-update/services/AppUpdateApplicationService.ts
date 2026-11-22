import type {
  CheckForUpdateDTO,
  DownloadUpdateDTO,
  InstallUpdateDTO,
  ReadUpdateStatusDTO
} from '../dto/AppUpdateDTO'
import type { UpdateCheckVO, UpdateStatusVO } from '../vo/AppUpdateVO'

export interface AppUpdateApplicationService {
  checkForUpdate(request: CheckForUpdateDTO): Promise<UpdateCheckVO>

  downloadUpdate(request: DownloadUpdateDTO): Promise<UpdateStatusVO>

  installUpdate(request: InstallUpdateDTO): Promise<void>

  readStatus(request: ReadUpdateStatusDTO): Promise<UpdateStatusVO>

  subscribe(listener: (status: UpdateStatusVO) => void): () => void
}
