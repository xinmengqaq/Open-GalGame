export interface DirectoryOpenGateway {
  /**
   * 校验并交给系统打开本机绝对目录。
   * @throws {AppException} 路径不是已存在的绝对目录，或系统无法打开。
   */
  openDirectory(absolutePath: string): Promise<void>
}
