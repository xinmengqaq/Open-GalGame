import { describe, expect, it } from 'vitest'

import { ProjectImportedEvent } from '@domain/projects/events/ProjectImportedEvent'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

const service = new ProjectDomainServiceImpl()
describe('目录导入领域规则', () => {
  it('接纳已读取或初始化的合法身份，不要求工程包构件', () => {
    const project = service.prepareImport({
      workspace: { kind: 'uninitialized', directoryName: ' 故事 ' },
      candidate: { id: 'story', name: ' 故事 ', synopsis: '一\n二' },
      registeredIdentity: null
    }).project
    expect(project.name).toBe('故事')
    expect(project.synopsis).toBe('一\n二')
    expect(project.events).toHaveLength(1)
    expect(project.events[0]).toBeInstanceOf(ProjectImportedEvent)
  })
  it('重复标识拒绝，同名不同标识允许', () => {
    expect(() =>
      service.prepareImport({
        workspace: { kind: 'uninitialized', directoryName: '目录' },
        candidate: { id: 'same', name: '故事' },
        registeredIdentity: { id: 'same' }
      })
    ).toThrowError(expect.objectContaining({ code: 1205, message: '此项目已登记，不能重复导入' }))
    expect(
      service.prepareImport({
        workspace: { kind: 'uninitialized', directoryName: '目录' },
        candidate: { id: 'other', name: '故事' },
        registeredIdentity: { id: 'same' }
      }).project.id
    ).toBe('other')
  })
  it('空目录名使用默认名称，标识规则先于登记冲突', () => {
    expect(
      service.prepareImport({
        workspace: { kind: 'uninitialized', directoryName: ' ' },
        candidate: { id: 'other', name: '' },
        registeredIdentity: null
      }).project.name
    ).toBe('未命名项目')
    expect(() =>
      service.prepareImport({
        workspace: { kind: 'uninitialized', directoryName: '目录' },
        candidate: { id: 'bad id', name: '故事' },
        registeredIdentity: null
      })
    ).toThrowError(expect.objectContaining({ code: 1104 }))
  })
})
