import type { OpenDirectoryDTO } from '../../dto/OpenDirectoryDTO'
import type { DirectoryOpenGateway } from '../../ports/DirectoryOpenGateway'
import type { OpenDirectoryApplicationService } from '../OpenDirectoryApplicationService'

export interface OpenDirectoryApplicationDependencies {
  readonly directories: DirectoryOpenGateway
}

export class OpenDirectoryApplicationServiceImpl implements OpenDirectoryApplicationService {
  constructor(private readonly deps: OpenDirectoryApplicationDependencies) {}

  async openDirectory(request: OpenDirectoryDTO): Promise<void> {
    await this.deps.directories.openDirectory(request.path)
  }
}
