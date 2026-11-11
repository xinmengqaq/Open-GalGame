import { describe, expect, it } from 'vitest'

import { createProjectApplicationFixture } from '../../support/projectApplicationFixture'
import { AppException } from '@common/errors/AppException'
import { Project } from '@domain/projects/models/Project'

describe('项目打开、重命名与移出', () => {
  it('打开可读项目返回摘要且不写盘', async () => {
    const f = createProjectApplicationFixture([{ id: 'story-1', directory: '/story-1' }])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'story-1', name: '未寄出的信', synopsis: '第一句' }
    })
    await expect(f.service.openProject({ id: 'story-1' })).resolves.toEqual({
      id: 'story-1',
      name: '未寄出的信',
      synopsis: '第一句'
    })
    expect(f.storage.saveProjectInfo).not.toHaveBeenCalled()
    expect(f.registration.removeRegistration).not.toHaveBeenCalled()
    expect(f.storage.discard).not.toHaveBeenCalled()
  })

  it('未登记不能打开，不可用工程不能打开', async () => {
    const missing = createProjectApplicationFixture([])
    await expect(missing.service.openProject({ id: 'ghost' })).rejects.toMatchObject({
      code: 1209,
      message: '该项目未在本机列表中'
    })
    expect(missing.storage.inspect).not.toHaveBeenCalled()

    const broken = createProjectApplicationFixture([{ id: 'broken', directory: '/broken' }])
    broken.storage.inspect.mockRejectedValue(new AppException({ code: 1206, msg: '缺少内容' }))
    await expect(broken.service.openProject({ id: 'broken' })).rejects.toMatchObject({ code: 1206 })
  })

  it('重命名写回工程信息，不删登记、不删文件', async () => {
    const f = createProjectApplicationFixture([{ id: 'story-1', directory: '/story-1' }])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'story-1', name: '旧名', synopsis: '原文' }
    })
    f.storage.saveProjectInfo.mockResolvedValue('saved')
    await expect(
      f.service.renameProject({ id: 'story-1', name: '  新名  ', synopsis: '一\n二' })
    ).resolves.toEqual({ id: 'story-1', name: '新名', synopsis: '一\n二' })
    expect(f.storage.saveProjectInfo).toHaveBeenCalledTimes(1)
    const saved = f.storage.saveProjectInfo.mock.calls[0]
    expect(saved[0]).toEqual({ directory: '/story-1' })
    expect(saved[1]).toBeInstanceOf(Project)
    expect(saved[1]).toMatchObject({ id: 'story-1', name: '新名', synopsis: '一\n二' })
    expect(f.registration.removeRegistration).not.toHaveBeenCalled()
    expect(f.storage.discard).not.toHaveBeenCalled()
    expect(f.storage.initialize).not.toHaveBeenCalled()
  })

  it('空名称在写入前拒绝', async () => {
    const f = createProjectApplicationFixture([{ id: 'story-1', directory: '/story-1' }])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'story-1', name: '旧名', synopsis: '' }
    })
    await expect(f.service.renameProject({ id: 'story-1', name: '  ' })).rejects.toMatchObject({
      code: 1101
    })
    expect(f.storage.saveProjectInfo).not.toHaveBeenCalled()
  })

  it('写入缺失时由领域拒绝，不把技术结果当成已改名', async () => {
    const f = createProjectApplicationFixture([{ id: 'story-1', directory: '/story-1' }])
    f.storage.inspect.mockResolvedValue({
      kind: 'existing',
      project: { id: 'story-1', name: '旧名', synopsis: '' }
    })
    f.storage.saveProjectInfo.mockResolvedValue('missing')
    await expect(f.service.renameProject({ id: 'story-1', name: '新名' })).rejects.toMatchObject({
      code: 1206
    })
  })

  it('移出只删登记，不检查工程、不删文件', async () => {
    const f = createProjectApplicationFixture([{ id: 'broken', directory: '/missing' }])
    f.registration.removeRegistration.mockResolvedValue('removed')
    await expect(f.service.unregisterProject({ id: 'broken' })).resolves.toEqual({ id: 'broken' })
    expect(f.registration.removeRegistration).toHaveBeenCalledWith('broken')
    expect(f.storage.inspect).not.toHaveBeenCalled()
    expect(f.storage.discard).not.toHaveBeenCalled()
    expect(f.storage.initialize).not.toHaveBeenCalled()
    expect(f.storage.saveProjectInfo).not.toHaveBeenCalled()
  })

  it('未登记不能移出', async () => {
    const f = createProjectApplicationFixture([])
    await expect(f.service.unregisterProject({ id: 'ghost' })).rejects.toMatchObject({ code: 1209 })
    expect(f.registration.removeRegistration).not.toHaveBeenCalled()
  })
})

describe('新建保存位置', () => {
  it('选择保存位置返回目录，取消为 null', async () => {
    const f = createProjectApplicationFixture([])
    f.dialogs.chooseSaveLocation.mockResolvedValueOnce({ directory: '/works/story' })
    await expect(f.service.chooseSaveLocation()).resolves.toEqual({ directory: '/works/story' })
    f.dialogs.chooseSaveLocation.mockResolvedValueOnce(null)
    await expect(f.service.chooseSaveLocation()).resolves.toBeNull()
  })

  it('清除待用保存位置交给选择器', () => {
    const f = createProjectApplicationFixture([])
    f.service.clearSaveLocation()
    expect(f.dialogs.clearSaveLocation).toHaveBeenCalledTimes(1)
  })
})
