import { describe, expect, it } from 'vitest'

import { createProjectApplicationFixture } from '../../support/projectApplicationFixture'
import { AppException } from '@common/errors/AppException'

const page = { offset: 0, limit: 9 }

describe('ProjectApplicationServiceImpl.listProjects', () => {
  it('按登记顺序读取当前页并返回总数', async () => {
    const f = createProjectApplicationFixture([{ id: 'story-1', directory: '/story-1' }])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'story-1', name: '月光工坊', synopsis: '原文' }
    })
    await expect(f.service.listProjects(page)).resolves.toEqual({
      entries: [{ status: 'available', id: 'story-1', name: '月光工坊', synopsis: '原文' }],
      total: 1,
      offset: 0,
      limit: 9
    })
    expect(f.storage.inspect).toHaveBeenCalledWith({ directory: '/story-1' })
  })

  it('只检查当前页的工程', async () => {
    const f = createProjectApplicationFixture([
      { id: 'a', directory: '/a' },
      { id: 'b', directory: '/b' },
      { id: 'c', directory: '/c' }
    ])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'b', name: '第二部', synopsis: '' }
    })
    await expect(f.service.listProjects({ offset: 1, limit: 1 })).resolves.toEqual({
      entries: [{ status: 'available', id: 'b', name: '第二部', synopsis: '' }],
      total: 3,
      offset: 1,
      limit: 1
    })
    expect(f.storage.inspect).toHaveBeenCalledTimes(1)
    expect(f.storage.inspect).toHaveBeenCalledWith({ directory: '/b' })
  })

  it('单项业务错误不影响其他登记，未知失败继续传播', async () => {
    const f = createProjectApplicationFixture([
      { id: 'missing', directory: '/missing' },
      { id: 'ok', directory: '/ok' }
    ])
    f.storage.inspect
      .mockRejectedValueOnce(new AppException({ code: 1308, msg: '目录不存在' }))
      .mockResolvedValueOnce({
        kind: 'existing',
        project: { id: 'ok', name: '作品', synopsis: '' }
      })
    await expect(f.service.listProjects(page)).resolves.toEqual({
      entries: [
        { status: 'unavailable', id: 'missing', code: 1308, msg: '目录不存在' },
        { status: 'available', id: 'ok', name: '作品', synopsis: '' }
      ],
      total: 2,
      offset: 0,
      limit: 9
    })
    expect(f.logger.warn).toHaveBeenCalledTimes(1)
    f.storage.inspect.mockRejectedValueOnce(new Error('boom'))
    await expect(f.service.listProjects(page)).rejects.toThrow('boom')
  })

  it('在应用层校验登记身份', async () => {
    const f = createProjectApplicationFixture([{ id: 'registered', directory: '/project' }])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'other', name: '作品', synopsis: '' }
    })
    await expect(f.service.listProjects(page)).resolves.toEqual({
      entries: [
        { status: 'unavailable', id: 'registered', code: 1203, msg: '工程身份与登记不一致' }
      ],
      total: 1,
      offset: 0,
      limit: 9
    })
  })

  it('空登记不读取工程，越界页为空且保留总数，登记文件失败原样传播', async () => {
    const empty = createProjectApplicationFixture([])
    await expect(empty.service.listProjects(page)).resolves.toEqual({
      entries: [],
      total: 0,
      offset: 0,
      limit: 9
    })
    expect(empty.storage.inspect).not.toHaveBeenCalled()

    const f = createProjectApplicationFixture([{ id: 'story-1', directory: '/story-1' }])
    await expect(f.service.listProjects({ offset: 9, limit: 9 })).resolves.toEqual({
      entries: [],
      total: 1,
      offset: 9,
      limit: 9
    })
    expect(f.storage.inspect).not.toHaveBeenCalled()

    const failure = new AppException({ code: 1304, msg: '读取失败' })
    f.listQuery.listRegistrations.mockRejectedValueOnce(failure)
    await expect(f.service.listProjects(page)).rejects.toBe(failure)
  })
})
