/**
 * 单场景导出错误码。
 * 4601 起只表达导出输入、保存前置和打包能力，不复用预览错误码。
 */
export const SceneExportErrorCodes = {
  exportInputRejected: 4601,
  saveNotCommitted: 4602,
  savedContentMismatch: 4603,
  windowsPackagerUnavailable: 4604,
  exportFailed: 4605
} as const

export type SceneExportErrorCode =
  (typeof SceneExportErrorCodes)[keyof typeof SceneExportErrorCodes]

export const sceneExportErrorMessages: Record<SceneExportErrorCode, string> = {
  [SceneExportErrorCodes.exportInputRejected]: '导出只接受已保存的当前场景',
  [SceneExportErrorCodes.saveNotCommitted]: '当前场景还没有保存成功，不能导出',
  [SceneExportErrorCodes.savedContentMismatch]: '当前内容与本次保存不一致，不能导出',
  [SceneExportErrorCodes.windowsPackagerUnavailable]: '当前没有可调用的 Windows 桌面打包入口',
  [SceneExportErrorCodes.exportFailed]: 'Windows 桌面导出没有完成'
}
