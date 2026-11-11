import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { ProjectUnregisteredEvent } from '@domain/projects/events/ProjectUnregisteredEvent'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

const service = new ProjectDomainServiceImpl()

describe('ProjectDomainService.prepareUnregister', () => {
  it('已登记身份允许移出，并带上移出事件', () => {
    const event = service.prepareUnregister({ id: 'story-1' })
    expect(event).toBeInstanceOf(ProjectUnregisteredEvent)
    expect(event).toMatchObject({ kind: 'unregistered', projectId: 'story-1' })
  })

  it('未登记拒绝，不要求工程可读', () => {
    try {
      service.prepareUnregister(null)
    } catch (error) {
      expect(error).toBeInstanceOf(AppException)
      expect(error).toMatchObject({
        code: ProjectErrorCodes.notRegistered,
        message: '该项目未在本机列表中'
      })
      return
    }
    throw new Error('expected AppException 1209')
  })
})
