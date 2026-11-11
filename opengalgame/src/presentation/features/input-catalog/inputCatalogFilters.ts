import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import { catalogGroupOf } from '../workbench-session/contentKindLabel'
import type { CatalogGroup, CatalogTypeFilter } from './inputCatalog.types'

export const catalogGroupOptions: ReadonlyArray<{ value: CatalogGroup; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'asset', label: '文件素材' }
]

export const catalogTypeOptions: ReadonlyArray<{ value: CatalogTypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'document', label: '文档' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'video', label: '视频' }
]

export function filterInputSources(
  sources: readonly ProjectInputSourceSummaryVO[],
  query: string,
  group: CatalogGroup,
  type: CatalogTypeFilter
): ProjectInputSourceSummaryVO[] {
  const needle = query.trim().toLowerCase()
  return sources.filter((source) => {
    if (group !== 'all' && catalogGroupOf(source.contentKind) !== group) return false
    if (type !== 'all') {
      if (source.contentKind === 'text') {
        if (source.textKind !== type) return false
      } else if (source.contentKind !== type) return false
    }
    if (!needle) return true
    return source.name.toLowerCase().includes(needle)
  })
}
