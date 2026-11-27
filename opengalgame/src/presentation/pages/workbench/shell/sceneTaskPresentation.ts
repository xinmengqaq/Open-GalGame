import type {
  ExportSavedSceneDTO,
  SceneExportDestinationDTO
} from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SystemPathClient } from '@interfaces/system-path/client/SystemPathClient'

import { requireSuccess } from '@presentation/feedback/failure'
import type { SceneExportNotice } from './SceneExportNotice'
import type { SavedSceneVersionFact } from './WorkbenchPreviewLayer'

/**
 * 只有明确的业务失败结果才能让教程宣告“这次没有导出成功”。
 * 通信中断、响应缺失或本机异常都表示导出是否落地未知；普通导出页仍保留原反馈。
 */
export function isDefiniteExportFailure(error: unknown): boolean {
  return error instanceof AppException && error.code !== ErrorCodes.communicationFailed
}

/**
 * 导出只带工程/场景身份、保存成功的内容依据、正式版本引用和目的地意向。
 * 不携带路径、草稿、候选快照、命令或预览会话；显式目录只带 selectionId。
 */
export function exportRequestOf(
  projectId: string,
  sceneId: string,
  saved: SavedSceneVersionFact,
  destination?: SceneExportDestinationDTO
): ExportSavedSceneDTO {
  return {
    projectId,
    sceneId,
    contentBasis: saved.contentBasis,
    versionReference: saved.versionReference,
    ...(destination === undefined ? {} : { destination })
  }
}

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

export async function openExportDirectory(
  client: Pick<SystemPathClient, 'openDirectory'>,
  directoryPath: string
): Promise<string> {
  const result = await client.openDirectory({ path: directoryPath })
  requireSuccess(result)
  return result.msg
}
