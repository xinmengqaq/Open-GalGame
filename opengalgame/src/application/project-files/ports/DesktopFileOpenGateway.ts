/** 用系统默认程序打开已经定位的工程文件。不创建作品提交。 */
export interface DesktopFileOpenGateway {
  /**
   * @param absolutePath - 已定位的工程内文件。不返回给调用方。
   * @throws {AppException} 系统拒绝打开。
   */
  open(absolutePath: string): Promise<void>
}
