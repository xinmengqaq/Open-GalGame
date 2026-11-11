import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { assertUserDirectory } from '@bootstrap/userDirectory'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

describe('用户目录', () => {
  it('拒绝尾部空格', () => {
    const error = (() => {
      try {
        assertUserDirectory(`${join('D:/opengalgame', 'user')} `)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code: ErrorCodes.invalidConfig })
  })

  it('拒绝相对路径', () => {
    expect(() => assertUserDirectory('opengalgame/user')).toThrow(AppException)
    expect(() => assertUserDirectory('opengalgame/user')).toThrow(
      expect.objectContaining({ code: ErrorCodes.invalidConfig })
    )
  })

  it('把合法绝对路径规范成 resolve 结果', () => {
    const directory = join('D:/opengalgame', 'user')
    expect(assertUserDirectory(directory)).toBe(resolve(directory))
  })

  it.runIf(process.platform === 'win32')('拒绝 Windows 段尾空格或点', () => {
    expect(() => assertUserDirectory('D:\\opengalgame \\user')).toThrow(
      expect.objectContaining({ code: ErrorCodes.invalidConfig })
    )
    expect(() => assertUserDirectory('D:\\opengalgame.\\user')).toThrow(
      expect.objectContaining({ code: ErrorCodes.invalidConfig })
    )
  })
})
