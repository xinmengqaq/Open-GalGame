import type { OpenDirectoryDTO } from '@application/system-path/dto/OpenDirectoryDTO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface SystemPathClient {
  openDirectory(request: OpenDirectoryDTO): Promise<AjaxResult<null>>
}
