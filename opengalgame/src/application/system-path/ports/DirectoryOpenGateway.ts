export interface DirectoryOpenGateway {
  openDirectory(absolutePath: string): Promise<void>
}
