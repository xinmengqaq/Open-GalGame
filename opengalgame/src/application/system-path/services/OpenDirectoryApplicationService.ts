import type { OpenDirectoryDTO } from '../dto/OpenDirectoryDTO'

export interface OpenDirectoryApplicationService {
  openDirectory(request: OpenDirectoryDTO): Promise<void>
}
