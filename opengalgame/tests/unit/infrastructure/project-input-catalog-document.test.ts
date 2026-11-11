import { describe, expect, it } from 'vitest'

import { projectInputCatalogDocumentSchema } from '@infrastructure/project-files/documents/ProjectInputCatalogDocument'

describe('目录持久化名称', () => {
  it('不接受空白或带路径的文件夹名', () => {
    const document = {
      formatVersion: 1,
      projectId: 'project-1',
      folders: [{ folderId: 'folder-1', parentFolderId: null, name: '   ' }],
      placements: []
    }
    expect(projectInputCatalogDocumentSchema.safeParse(document).success).toBe(false)
    expect(
      projectInputCatalogDocumentSchema.safeParse({
        ...document,
        folders: [{ folderId: 'folder-1', parentFolderId: null, name: 'a/b' }]
      }).success
    ).toBe(false)
    expect(
      projectInputCatalogDocumentSchema.safeParse({
        ...document,
        folders: [{ folderId: 'folder-1', parentFolderId: null, name: '资料' }]
      }).success
    ).toBe(true)
  })
})
