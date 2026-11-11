import { describe, expect, it } from 'vitest'

import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import {
  breadcrumbFolders,
  currentFolderEntries,
  isForbiddenFolderCopyTarget,
  pruneFolderTrail,
  searchCatalogEntries
} from '@presentation/features/input-catalog/inputCatalogTree'

const folders: readonly ProjectFolderVO[] = [
  { folderId: 'ref', parentFolderId: null, name: '参考资料' },
  { folderId: 'cast', parentFolderId: 'ref', name: '角色立绘' },
  { folderId: 'scene', parentFolderId: null, name: '场景背景' }
]

const sources: readonly ProjectInputSourceSummaryVO[] = [
  {
    sourceId: 'doc-1',
    name: '角色设定',
    readable: true,
    parentFolderId: 'ref',
    contentKind: 'text',
    textKind: 'document'
  },
  {
    sourceId: 'img-1',
    name: '工坊屋顶',
    readable: true,
    parentFolderId: 'scene',
    contentKind: 'image'
  }
]

describe('输入目录树', () => {
  it('当前目录先显示子文件夹再显示来源', () => {
    const entries = currentFolderEntries(folders, sources, null)
    expect(
      entries.map((entry) => (entry.kind === 'folder' ? entry.folder.name : entry.source.name))
    ).toEqual(['参考资料', '场景背景'])
  })

  it('进入子目录只显示该层内容', () => {
    const entries = currentFolderEntries(folders, sources, 'ref')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'folder', folder: { folderId: 'cast' } })
    expect(entries[1]).toMatchObject({ kind: 'source', source: { sourceId: 'doc-1' } })
  })

  it('搜索同时匹配文件夹和来源，并带祖先路径', () => {
    const entries = searchCatalogEntries(folders, sources, '角色', 'all', 'all')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'folder', path: '参考资料' })
    expect(entries[1]).toMatchObject({ kind: 'source', path: '参考资料' })
  })

  it('目录消失后回到仍存在的祖先', () => {
    expect(pruneFolderTrail(folders, ['ref', 'gone'])).toEqual(['ref'])
    expect(pruneFolderTrail(folders, ['gone'])).toEqual([])
    expect(breadcrumbFolders(folders, 'cast').map((folder) => folder.folderId)).toEqual([
      'ref',
      'cast'
    ])
  })

  it('禁止把文件夹复制到自身或后代', () => {
    expect(isForbiddenFolderCopyTarget(folders, 'ref', 'ref')).toBe(true)
    expect(isForbiddenFolderCopyTarget(folders, 'ref', 'cast')).toBe(true)
    expect(isForbiddenFolderCopyTarget(folders, 'ref', 'scene')).toBe(false)
    expect(isForbiddenFolderCopyTarget(folders, 'ref', null)).toBe(false)
  })
})
