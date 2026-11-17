import type { OpenDirectoryDTO } from '@application/system-path/dto/OpenDirectoryDTO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface SystemPathClient {
  /** 交给系统打开本机已存在的目录；服务端负责校验，客户端不接受任意命令。 */
  openDirectory(request: OpenDirectoryDTO): Promise<AjaxResult<null>>
}
