import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import { classifyMediaFileName } from '@common/media/mediaFileName'

import type { WorkspaceLoadStatus } from '../workbench-session/workbenchSession.types'

export type InputCatalogMediaKind = 'image' | 'audio' | 'video'

/**
 * 文件区能拖上画布的素材类别。null 表示目录尚未读定，不能当成“没有”。
 * 只携带类别布尔值，不含文件名、目录或正文。
 */
export type InputCatalogMediaAvailability = Readonly<
  Record<InputCatalogMediaKind, boolean | null>
>

export const UNKNOWN_INPUT_CATALOG_MEDIA_AVAILABILITY: InputCatalogMediaAvailability = {
  image: null,
  audio: null,
  video: null
}

/**
 * 从文件区真实可拖动的来源派生选材可用性。
 * 必须同时满足：来源可读取、末位后缀是候选、内容识别确认的类别与所需类别一致。
 * 共用容器只说明后缀适用于音视频，实际类别仍取内容识别的 contentKind。
 */
export function inputCatalogMediaAvailabilityOf(
  status: WorkspaceLoadStatus | null,
  sources: readonly ProjectInputSourceSummaryVO[]
): InputCatalogMediaAvailability {
  if (status !== 'ready' && status !== 'empty') return UNKNOWN_INPUT_CATALOG_MEDIA_AVAILABILITY
  const available = new Set(sources.map(inputCatalogMediaKindOf))
  return {
    image: available.has('image'),
    audio: available.has('audio'),
    video: available.has('video')
  }
}

/**
 * 文件区唯一的素材候选规则：可读取、末位后缀是候选、内容识别类别与后缀一致。
 * 目录可用性和本次导入回执都从这里派生，未知后缀（如 .xyz 的真 PNG）仍可
 * 普通导入，但不会被当成教程当拍所需素材。
 */
export function inputCatalogMediaKindOf(
  source: ProjectInputSourceSummaryVO
): InputCatalogMediaKind | null {
  if (!source.readable || source.contentKind === 'text') return null
  const kind = source.contentKind
  const candidate = classifyMediaFileName(source.name)
  if (candidate.status === 'identified') return candidate.category === kind ? kind : null
  if (candidate.status === 'container') return kind === 'audio' || kind === 'video' ? kind : null
  return null
}
