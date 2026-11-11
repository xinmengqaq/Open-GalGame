import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { chooseImportFileName } from '@domain/project-files/services/chooseImportFileName'
import { evaluateFileRename } from '@domain/project-files/services/evaluateFileRename'

function expectCode(run: () => unknown, code: number): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

describe('导入命名', () => {
  it('原名称未占用时直接使用，不改写大小写', () => {
    expect(chooseImportFileName('Notes.md', ['other.txt'])).toBe('Notes.md')
  })

  it('同名时在扩展名前依次追加序号，并跳过已占用序号', () => {
    expect(chooseImportFileName('photo.png', ['photo.png', 'photo (1).png'])).toBe('photo (2).png')
  })

  it('名称比较不区分大小写，避免目标位置折叠后覆盖已有文件', () => {
    expect(chooseImportFileName('Photo.PNG', ['photo.png'])).toBe('Photo (1).PNG')
  })

  it('拒绝空白名称和路径', () => {
    expectCode(() => chooseImportFileName('  ', []), ProjectFileErrorCodes.invalidFileName)
    expectCode(
      () => chooseImportFileName('dir/photo.png', []),
      ProjectFileErrorCodes.invalidFileName
    )
  })
})

describe('重命名规则', () => {
  it('名称未变化时不要求提交', () => {
    expect(evaluateFileRename('Notes.md', 'notes.md', [])).toEqual({ changed: false })
  })

  it('扩展名不变且目标未占用时接受新名称', () => {
    expect(evaluateFileRename('Notes.md', 'Chapter.MD', ['other.txt'])).toEqual({
      changed: true,
      fileName: 'Chapter.MD'
    })
  })

  it('扩展名改变时失败，不转换成另一种格式', () => {
    expectCode(
      () => evaluateFileRename('Notes.md', 'Notes.txt', []),
      ProjectFileErrorCodes.fileExtensionChanged
    )
  })

  it('目标名称被其他文件占用时失败，不自动覆盖', () => {
    expectCode(
      () => evaluateFileRename('Notes.md', 'Chapter.md', ['chapter.md']),
      ProjectFileErrorCodes.fileNameConflict
    )
  })

  it('不接受目录或缺少扩展名的名称', () => {
    expectCode(
      () => evaluateFileRename('Notes.md', 'folder\\Notes.md', []),
      ProjectFileErrorCodes.invalidFileName
    )
    expectCode(
      () => evaluateFileRename('Notes.md', 'Notes', []),
      ProjectFileErrorCodes.fileExtensionChanged
    )
  })
})
