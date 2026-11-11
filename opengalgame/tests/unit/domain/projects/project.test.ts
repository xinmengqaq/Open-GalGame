import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes, type ProjectErrorCode } from '@domain/projects/errors/ProjectErrorCodes'
import { ProjectCreatedEvent } from '@domain/projects/events/ProjectCreatedEvent'
import { ProjectImportedEvent } from '@domain/projects/events/ProjectImportedEvent'
import {
  Project,
  PROJECT_ID_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH
} from '@domain/projects/models/Project'

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

describe('Project.create', () => {
  it('去掉名称首尾空白，缺省简介为空字符串，并带上创建事件', () => {
    const project = Project.create({
      id: 'story-1',
      name: '  月光工坊  ',
      synopsis: undefined
    })

    expect(project.id).toBe('story-1')
    expect(project.name).toBe('月光工坊')
    expect(project.synopsis).toBe('')
    expect(project.events).toHaveLength(1)
    expect(project.events[0]).toBeInstanceOf(ProjectCreatedEvent)
    expect(project.events[0]).toMatchObject({ projectId: 'story-1', name: '月光工坊' })
    expect(project.events.some((event) => event instanceof ProjectImportedEvent)).toBe(false)
  })

  it('空白名称拒绝', () => {
    expectAppCode(() => Project.create({ id: 'story-1', name: '' }), ProjectErrorCodes.emptyName)
    expectAppCode(() => Project.create({ id: 'story-1', name: '   ' }), ProjectErrorCodes.emptyName)
  })

  it(`名称最长 ${PROJECT_NAME_MAX_LENGTH} 个字素`, () => {
    const limit = '啊'.repeat(PROJECT_NAME_MAX_LENGTH)
    const project = Project.create({ id: 'story-1', name: limit })
    expect(project.name).toBe(limit)

    expectAppCode(
      () => Project.create({ id: 'story-1', name: `${limit}啊` }),
      ProjectErrorCodes.nameTooLong
    )
  })

  it('名称按字素计数，组合字符与表情只占一个名额', () => {
    const family = '👨‍👩‍👧‍👦'
    const limit = family.repeat(PROJECT_NAME_MAX_LENGTH)
    expect(Project.create({ id: 'story-1', name: limit }).name).toBe(limit)

    expectAppCode(
      () => Project.create({ id: 'story-1', name: `${limit}${family}` }),
      ProjectErrorCodes.nameTooLong
    )
  })

  it('简介可空、保留换行和空白，且不因很长而失败', () => {
    const synopsis = '  第一行  \n第二行\n\n'
    const project = Project.create({
      id: 'story-1',
      name: '月光工坊',
      synopsis
    })
    expect(project.synopsis).toBe(synopsis)

    const longSynopsis = `${'段'.repeat(10_000)}\n尾`
    expect(
      Project.create({ id: 'story-1', name: '月光工坊', synopsis: longSynopsis }).synopsis
    ).toBe(longSynopsis)
  })

  it(`标识必须非空、无空白、最长 ${PROJECT_ID_MAX_LENGTH} 个码点`, () => {
    expectAppCode(() => Project.create({ id: '', name: '月光工坊' }), ProjectErrorCodes.invalidId)
    expectAppCode(
      () => Project.create({ id: '  story-1', name: '月光工坊' }),
      ProjectErrorCodes.invalidId
    )
    expectAppCode(
      () => Project.create({ id: 'story 1', name: '月光工坊' }),
      ProjectErrorCodes.invalidId
    )
    expectAppCode(
      () => Project.create({ id: 'a'.repeat(PROJECT_ID_MAX_LENGTH + 1), name: '月光工坊' }),
      ProjectErrorCodes.invalidId
    )

    const maxId = '啊'.repeat(PROJECT_ID_MAX_LENGTH)
    expect(Project.create({ id: maxId, name: '月光工坊' }).id).toBe(maxId)
  })
})
