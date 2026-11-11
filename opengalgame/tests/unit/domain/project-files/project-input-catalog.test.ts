import { describe, expect, it } from 'vitest'

import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { evaluateFileMove } from '@domain/project-files/services/evaluateFileMove'
import {
  chooseFolderCopyName,
  evaluateFolderRename
} from '@domain/project-files/services/folderNameRules'
import { validateFolderCopyTarget } from '@domain/project-files/services/validateFolderCopyTarget'
import { validateProjectInputCatalog } from '@domain/project-files/services/validateProjectInputCatalog'
import { AppException } from '@common/errors/AppException'

const folders = [
  { folderId: 'parent', parentFolderId: null, name: '资料' },
  { folderId: 'child', parentFolderId: 'parent', name: '章节' }
]

describe('工程文件目录规则', () => {
  it('修剪后为空的名称算目录损坏', () => {
    expect(() =>
      validateProjectInputCatalog(
        {
          folders: [{ folderId: 'blank', parentFolderId: null, name: '   ' }],
          placements: []
        },
        [{ id: 'blank', parentFolderId: null, name: '   ' }]
      )
    ).toThrow(AppException)
    try {
      validateProjectInputCatalog(
        {
          folders: [{ folderId: 'blank', parentFolderId: null, name: '   ' }],
          placements: []
        },
        [{ id: 'blank', parentFolderId: null, name: '   ' }]
      )
    } catch (error) {
      expect(error).toMatchObject({ code: ProjectFileErrorCodes.catalogDamaged })
    }
  })

  it('拒绝环、缺失父目录和同目录重名', () => {
    expect(() =>
      validateProjectInputCatalog(
        {
          folders: [{ folderId: 'loop', parentFolderId: 'loop', name: '环' }],
          placements: []
        },
        []
      )
    ).toThrow(AppException)
    expect(() =>
      validateProjectInputCatalog(
        {
          folders,
          placements: [
            { sourceId: 'source-1', parentFolderId: 'missing' },
            { sourceId: 'source-1', parentFolderId: 'parent' }
          ]
        },
        []
      )
    ).toThrow(AppException)
    expect(() =>
      validateProjectInputCatalog({ folders, placements: [] }, [
        { id: 'parent', parentFolderId: null, name: '资料' },
        { id: 'source-1', parentFolderId: null, name: '资料' }
      ])
    ).toThrow(AppException)
  })

  it('允许不同父目录同名，并拒绝复制到自身或后代', () => {
    expect(() =>
      validateProjectInputCatalog(
        { folders, placements: [{ sourceId: 'source-1', parentFolderId: 'child' }] },
        [
          { id: 'parent', parentFolderId: null, name: '资料' },
          { id: 'child', parentFolderId: 'parent', name: '资料' },
          { id: 'source-1', parentFolderId: 'child', name: '笔记.md' }
        ]
      )
    ).not.toThrow()
    expect(() => validateFolderCopyTarget(folders, 'parent', 'child')).toThrow(AppException)
    expect(() => validateFolderCopyTarget(folders, 'child', null)).not.toThrow()
  })

  it('同目录移动不变化，归属变化和目标同名失败', () => {
    expect(
      evaluateFileMove({
        currentParentFolderId: 'parent',
        expectedParentFolderId: 'parent',
        targetFolderId: 'parent',
        fileName: '笔记.md',
        occupiedNamesInTarget: ['笔记.md']
      })
    ).toEqual({ changed: false })
    expect(() =>
      evaluateFileMove({
        currentParentFolderId: 'child',
        expectedParentFolderId: 'parent',
        targetFolderId: null,
        fileName: '笔记.md',
        occupiedNamesInTarget: []
      })
    ).toThrow(AppException)
    expect(evaluateFolderRename('资料', '资料', [])).toEqual({ changed: false })
    expect(chooseFolderCopyName('资料', ['资料', '资料 (1)'])).toBe('资料 (2)')
  })

  it('目录损坏使用目录损坏错误码', () => {
    try {
      validateProjectInputCatalog(
        { folders: [{ folderId: 'a', parentFolderId: 'missing', name: '甲' }], placements: [] },
        []
      )
      throw new Error('应该失败')
    } catch (error) {
      expect(error).toBeInstanceOf(AppException)
      expect((error as AppException).code).toBe(ProjectFileErrorCodes.catalogDamaged)
    }
  })
})
