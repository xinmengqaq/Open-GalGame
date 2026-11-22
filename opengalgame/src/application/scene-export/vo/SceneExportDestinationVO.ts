/**
 * 主进程完成目录选择后的结果。
 * `selected` 只签发 selectionId 供导出请求使用（10 分钟内可重试复用）；
 * 路径仅供界面展示，不回传到导出请求。
 */
export type SceneExportDirectoryChoiceVO =
  | {
      readonly status: 'selected'
      readonly selectionId: string
      readonly directoryPath: string
    }
  | {
      readonly status: 'canceled'
    }
