import { describe, expect, it } from 'vitest'

import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

describe('项目登记冲突裁决', () => {
  it('只将冲突事实解释为重复登记，成功及幂等重放均允许完成', () => {
    const service = new ProjectDomainServiceImpl()
    expect(() => service.validateRegistration({ status: 'registered' })).not.toThrow()
    expect(() => service.validateRegistration({ status: 'alreadyRegistered' })).not.toThrow()
    expect(() => service.validateRegistration({ status: 'conflict' })).toThrowError(
      expect.objectContaining({ code: 1205, message: '此项目已登记，不能重复导入' })
    )
  })
})
