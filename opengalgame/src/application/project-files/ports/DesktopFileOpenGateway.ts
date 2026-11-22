export interface DesktopFileOpenGateway {
  open(absolutePath: string): Promise<void>
}
