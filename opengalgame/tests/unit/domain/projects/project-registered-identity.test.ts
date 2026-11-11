import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes, type ProjectErrorCode } from '@domain/projects/errors/ProjectErrorCodes'
import { Project } from '@domain/projects/models/Project'

function expectAppCode(run: () => unknown, code: ProjectErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({
      code
    })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

describe('Project.validateRegisteredIdentity', () => {
  it('登记标识与工程标识一致时通过', () => {
    const project = Project.restore({ id: 'story-1', name: '月光工坊' })

    expect(() => project.validateRegisteredIdentity({ id: 'story-1' })).not.toThrow()
  })

  it('登记标识与工程标识不一致时按稳定业务码拒绝', () => {
    const project = Project.restore({ id: 'story-1', name: '月光工坊' })

    expectAppCode(
      () => project.validateRegisteredIdentity({ id: 'other' }),
      ProjectErrorCodes.packageCorrupted
    )
    expectAppCode(
      () => project.validateRegisteredIdentity({ id: '' }),
      ProjectErrorCodes.packageCorrupted
    )
  })

  it('校验不新增领域事件，也不修改已恢复的项目', () => {
    const project = Project.restore({ id: 'story-1', name: '月光工坊', synopsis: '原文' })

    expect(() => project.validateRegisteredIdentity({ id: 'story-1' })).not.toThrow()
    expect(() => project.validateRegisteredIdentity({ id: 'other' })).toThrow()

    expect(project.events).toEqual([])
    expect(project).toMatchObject({ id: 'story-1', name: '月光工坊', synopsis: '原文' })
  })
})
