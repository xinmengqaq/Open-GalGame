import { describe, expect, it } from 'vitest'

import {
  fieldForErrorCode,
  homeFailureAction,
  homeWorkspaceFailure,
  workspaceProjectIdFrom
} from '@presentation/feedback/homeResult'

describe('首页错误码落点', () => {
  it('把名称错误落到名称字段', () => {
    expect(fieldForErrorCode(1101)).toBe('name')
    expect(fieldForErrorCode(1102)).toBe('name')
  })

  it('登记失败需要重试原请求完成登记', () => {
    expect(homeFailureAction(1306)).toBe('retry-registration')
  })

  it('工作区未就绪只提供重新构建，不重试登记', () => {
    expect(homeFailureAction(1309)).toBe('rebuild-workspace')
    expect(homeFailureAction(1309)).not.toBe('retry-registration')
  })

  it('其他失败不提供生命周期动作', () => {
    expect(homeFailureAction(1302)).toBe('none')
    expect(homeFailureAction(5102)).toBe('none')
  })

  it('重新构建文案是固定安全说明，不含路径或内部项', () => {
    const copy = `${homeWorkspaceFailure.title}${homeWorkspaceFailure.detail}`
    expect(copy).not.toMatch(/\.git|D:\/|锁|仓库|1309/i)
  })
})

describe('首页失败携带的工程身份', () => {
  it('只接受原样非空字符串', () => {
    expect(workspaceProjectIdFrom({ projectId: 'project-1' })).toBe('project-1')
    expect(workspaceProjectIdFrom({ projectId: ' project-1' })).toBeNull()
    expect(workspaceProjectIdFrom({ projectId: '   ' })).toBeNull()
  })

  it('缺字段或不是对象时不猜测', () => {
    expect(workspaceProjectIdFrom(undefined)).toBeNull()
    expect(workspaceProjectIdFrom(null)).toBeNull()
    expect(workspaceProjectIdFrom({ status: 'completed' })).toBeNull()
    expect(workspaceProjectIdFrom({ projectId: 42 })).toBeNull()
  })
})
