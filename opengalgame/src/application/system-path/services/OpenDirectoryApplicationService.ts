import type { OpenDirectoryDTO } from '../dto/OpenDirectoryDTO'

export interface OpenDirectoryApplicationService {
  /**
   * 打开本机已存在的绝对目录。
   * @throws {AppException} 路径不是已存在的绝对目录，或系统无法打开。
   */
  openDirectory(request: OpenDirectoryDTO): Promise<void>
}
