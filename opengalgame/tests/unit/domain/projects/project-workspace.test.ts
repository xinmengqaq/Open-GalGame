import { describe, expect, it } from 'vitest'

import { Project } from '@domain/projects/models/Project'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

const service = new ProjectDomainServiceImpl()
const info = { id: 'story', name: '故事' }

describe('工作区准备与恢复规则', () => {
  it('新建只允许初始化普通目录，不能覆盖已有项目', () => {
    const project = Project.create(info)
    expect(
      service.prepareCreation({
        project,
        workspace: { kind: 'uninitialized', directoryName: '目录' }
      })
    ).toEqual({ project, requiresInitialization: true })
    expect(() =>
      service.prepareCreation({ project, workspace: { kind: 'existing', project: info } })
    ).toThrowError(expect.objectContaining({ code: 1303 }))
  })

  it('普通目录导入需要初始化，已有项目导入沿用其身份', () => {
    expect(
      service.prepareImport({
        candidate: info,
        registeredIdentity: null,
        workspace: { kind: 'uninitialized', directoryName: '目录' }
      }).requiresInitialization
    ).toBe(true)
    const result = service.prepareImport({
      candidate: { id: 'unused', name: '候选' },
      registeredIdentity: null,
      workspace: { kind: 'existing', project: info }
    })
    expect(result.requiresInitialization).toBe(false)
    expect(result.project.id).toBe('story')
  })

  it('恢复拒绝身份丢失或替换，仅同一身份可继续', () => {
    expect(() =>
      service.validateRecovery({
        expectedProject: info,
        workspace: { kind: 'existing', project: info }
      })
    ).not.toThrow()
    for (const workspace of [
      { kind: 'uninitialized', directoryName: '目录' } as const,
      { kind: 'existing', project: { ...info, id: 'other' } } as const
    ]) {
      expect(() => service.validateRecovery({ expectedProject: info, workspace })).toThrowError(
        expect.objectContaining({ code: 1203 })
      )
    }
  })
})
