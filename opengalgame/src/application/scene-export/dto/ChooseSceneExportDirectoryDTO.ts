/**
 * 选择导出父目录。
 * 请求只带工程与场景身份；打开哪个目录由主进程决定，不由表现层指定。
 */
export type ChooseSceneExportDirectoryDTO = {
  readonly projectId: string
  readonly sceneId: string
}
