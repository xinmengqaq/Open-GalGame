import { describe, expect, it } from 'vitest'

import { emptyDocumentSaveDraft } from '@presentation/features/document-layer/emptyDocumentDraft'
import { catalogShortcutAction } from '@presentation/features/input-catalog/inputCatalogShortcuts'

describe('文件区快捷键', () => {
  it('没有文件菜单时不复制不剪切，文件夹菜单的粘贴仍指向当前目录', () => {
    expect(catalogShortcutAction('c', null)).toBe('ignore')
    expect(catalogShortcutAction('x', 'folder')).toBe('ignore')
    expect(catalogShortcutAction('c', 'file')).toBe('copy-file')
    expect(catalogShortcutAction('x', 'file')).toBe('cut-file')
    expect(catalogShortcutAction('v', 'folder')).toBe('paste-current')
    expect(catalogShortcutAction('v', null)).toBe('paste-current')
  })
})

describe('空文档编辑器草稿', () => {
  it('空正文不创建，文件名按格式补扩展名', () => {
    expect(emptyDocumentSaveDraft({ fileName: '设定', format: 'markdown', body: '   ' })).toBe(
      'empty-body'
    )
    expect(emptyDocumentSaveDraft({ fileName: '  ', format: 'markdown', body: '正文' })).toBe(
      'blank-name'
    )
    expect(emptyDocumentSaveDraft({ fileName: '设定', format: 'markdown', body: '正文' })).toEqual({
      fileName: '设定.md',
      format: 'markdown',
      body: '正文'
    })
    expect(
      emptyDocumentSaveDraft({ fileName: '设定.txt', format: 'plainText', body: '正文' })
    ).toEqual({
      fileName: '设定.txt',
      format: 'plainText',
      body: '正文'
    })
  })
})
