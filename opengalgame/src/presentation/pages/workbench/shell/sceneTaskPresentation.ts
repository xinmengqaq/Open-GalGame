import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'

import { requireSuccess } from '@presentation/feedback/failure'
import type { SceneExportNotice } from './SceneExportStatus'
import type { SavedSceneVersionFact } from './WorkbenchPreviewLayer'

/**
 * 导出只带工程/场景身份、保存成功的内容依据和预览保存引用。
 * 不携带路径、草稿、候选快照、命令或预览会话。
 */
export function exportRequestOf(
  projectId: string,
  sceneId: string,
  saved: SavedSceneVersionFact
): ExportSavedSceneDTO {
  return {
    projectId,
    sceneId,
    contentBasis: saved.contentBasis,
    versionReference: { kind: 'preview-save', requestId: saved.requestId }
  }
}

/**
 * 读取保存成功的导出结果：产物绝对路径由后端校验后写入 `directoryPath`，
 * 这里只负责带出展示字段，不拼接、不裁剪路径。
 */
export function exportNoticeOf(result: SceneExportResultVO): SceneExportNotice {
  if (result.status === 'succeeded') {
    return {
      tone: 'ok',
      label: '已导出',
      detail: `已生成 ${result.artifact.executableName}（${formatExportBytes(result.artifact.bytes)}）`,
      directoryPath: result.artifact.directoryPath
    }
  }
  if (result.status === 'failed') {
    return { tone: 'danger', label: '导出失败', detail: result.message }
  }
  if (result.status === 'unavailable') {
    return { tone: 'warning', label: '暂不可用', detail: result.message }
  }
  return { tone: 'warning', label: '导出未完成', detail: '打包仍在进行，请稍后再试。' }
}

export function formatExportBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * 把导出产物目录交给系统打开。
 * 成功只返回，失败抛出统一异常（由提示区转成用户语言），不吞掉失败。
 * @throws {AppException} 打开目录失败时抛出。
 */
export async function openExportDirectory(
  client: Pick<SceneExportClient, 'openDirectory'>,
  directoryPath: string
): Promise<void> {
  requireSuccess(await client.openDirectory({ path: directoryPath }))
}
