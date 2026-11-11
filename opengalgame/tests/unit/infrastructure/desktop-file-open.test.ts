import { describe, expect, it } from 'vitest'

import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { LocalDesktopFileOpenGatewayImpl } from '@infrastructure/project-files/LocalDesktopFileOpenGatewayImpl'

describe('系统打开', () => {
  it('空字符串表示系统接受请求，非空字符串是明确失败', async () => {
    const opened: string[] = []
    const gateway = new LocalDesktopFileOpenGatewayImpl(async (absolutePath) => {
      opened.push(absolutePath)
      return ''
    })
    await gateway.open('D:/works/project-1/notes.md')
    expect(opened).toEqual(['D:/works/project-1/notes.md'])
    const rejected = new LocalDesktopFileOpenGatewayImpl(async () => '找不到程序')
    await expect(rejected.open('D:/works/project-1/notes.md')).rejects.toMatchObject({
      code: ProjectFileErrorCodes.fileOpenFailed
    })
  })
})
