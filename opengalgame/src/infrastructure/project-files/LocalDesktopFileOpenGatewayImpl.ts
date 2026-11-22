import type { DesktopFileOpenGateway } from '@application/project-files/ports/DesktopFileOpenGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'

async function openWithElectron(absolutePath: string): Promise<string> {
  const { shell } = await import('electron')
  return shell.openPath(absolutePath)
}

export class LocalDesktopFileOpenGatewayImpl implements DesktopFileOpenGateway {
  constructor(
    private readonly openPath: (absolutePath: string) => Promise<string> = openWithElectron
  ) {}

  async open(absolutePath: string): Promise<void> {
    const result = await this.openPath(absolutePath)
    if (result !== '') {
      throw new AppException({
        code: ProjectFileErrorCodes.fileOpenFailed,
        msg: '系统无法打开该文件'
      })
    }
  }
}
