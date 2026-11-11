import { describe, expect, it } from 'vitest'

import { filterInputSources } from '@presentation/features/input-catalog/inputCatalogFilters'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'

const sources: ProjectInputSourceSummaryVO[] = [
  {
    sourceId: 'd1',
    name: '角色设定',
    readable: true,
    parentFolderId: null,
    contentKind: 'text',
    textKind: 'document'
  },
  { sourceId: 'b1', name: '工坊屋顶', readable: true, parentFolderId: null, contentKind: 'image' }
]

describe('输入目录筛选', () => {
  it('按一级分组筛选', () => {
    expect(filterInputSources(sources, '', 'text', 'all').map((item) => item.sourceId)).toEqual([
      'd1'
    ])
    expect(filterInputSources(sources, '', 'asset', 'all')).toHaveLength(1)
  })

  it('按二级类型和名称筛选', () => {
    expect(filterInputSources(sources, '', 'all', 'document').map((item) => item.sourceId)).toEqual(
      ['d1']
    )
    expect(filterInputSources(sources, '屋顶', 'all', 'all').map((item) => item.sourceId)).toEqual([
      'b1'
    ])
  })
})
