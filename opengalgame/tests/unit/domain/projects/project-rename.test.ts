import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes, type ProjectErrorCode } from '@domain/projects/errors/ProjectErrorCodes'
import { ProjectRenamedEvent } from '@domain/projects/events/ProjectRenamedEvent'
import { Project, PROJECT_NAME_MAX_LENGTH } from '@domain/projects/models/Project'

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

describe('Project.rename', () => {
  it('去掉名称首尾空白，保留简介换行，不改标识，并带上重命名事件', () => {
    const original = Project.restore({
      id: 'story-1',
      name: '旧名',
      synopsis: '原文'
    })
    const renamed = original.rename({ name: '  未寄出的信  ', synopsis: '第一行\n第二行' })

    expect(renamed.id).toBe('story-1')
    expect(renamed.name).toBe('未寄出的信')
    expect(renamed.synopsis).toBe('第一行\n第二行')
    expect(renamed.events).toHaveLength(1)
    expect(renamed.events[0]).toBeInstanceOf(ProjectRenamedEvent)
    expect(renamed.events[0]).toMatchObject({
      kind: 'renamed',
      projectId: 'story-1',
      name: '未寄出的信'
    })
    expect(original).toMatchObject({ id: 'story-1', name: '旧名', synopsis: '原文', events: [] })
  })

  it('空白名称拒绝', () => {
    const project = Project.restore({ id: 'story-1', name: '旧名' })
    expectAppCode(() => project.rename({ name: '' }), ProjectErrorCodes.emptyName)
    expectAppCode(() => project.rename({ name: '   ' }), ProjectErrorCodes.emptyName)
  })

  it(`名称最长 ${PROJECT_NAME_MAX_LENGTH} 个字素`, () => {
    const project = Project.restore({ id: 'story-1', name: '旧名' })
    const limit = '啊'.repeat(PROJECT_NAME_MAX_LENGTH)
    expect(project.rename({ name: limit }).name).toBe(limit)
    expectAppCode(() => project.rename({ name: `${limit}啊` }), ProjectErrorCodes.nameTooLong)
  })

  it('缺省简介为空字符串，且不改标识', () => {
    const project = Project.restore({ id: 'story-1', name: '旧名', synopsis: '原文' })
    const renamed = project.rename({ name: '新名' })
    expect(renamed.synopsis).toBe('')
    expect(renamed.id).toBe('story-1')
  })
})
