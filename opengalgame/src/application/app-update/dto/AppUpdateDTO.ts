/** 用户主动检查或应用启动后的后台检查。 */
export type CheckForUpdateDTO = {
  reason: 'manual' | 'background'
}

/** 下载已确认可用的更新。不接受发布源或目标路径。 */
export type DownloadUpdateDTO = Record<string, never>

/** 重启并静默安装已下载的更新。 */
export type InstallUpdateDTO = Record<string, never>

/** 读取当前更新状态。 */
export type ReadUpdateStatusDTO = Record<string, never>
