import type { DesktopFileOpenGateway } from '@application/project-files/ports/DesktopFileOpenGateway'
import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'

/** Electron 只在真正打开时加载，避免纯 Node 的开发后端在导入阶段绑定 Electron。 */
async function openWithElectron(absolutePath: string): Promise<string> {
  const { shell } = await import('electron')
  return shell.openPath(absolutePath)
}

/** 用系统默认程序打开工程文件。 */
export class LocalDesktopFileOpenGatewayImpl implements DesktopFileOpenGateway {
  /**
   * @param openPath - 测试替身；不传时使用 Electron shell。
   */
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
