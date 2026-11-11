import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ElectronProjectFileDialogGatewayImpl } from '@infrastructure/projects/ElectronProjectFileDialogGatewayImpl'

describe('目录选择器记住保存位置', () => {
  it('选择后记住父目录，下次作为默认位置，并供创建直接取用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'save-location-'))
    const project = join(root, 'works', 'story')
    await mkdir(project, { recursive: true })
    const userDirectory = join(root, 'app')
    const showDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: [project] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const gateway = new ElectronProjectFileDialogGatewayImpl(() => null, userDirectory, showDialog)

    const chosen = await gateway.chooseSaveLocation()
    expect(chosen?.directory).toBeTruthy()
    expect(await gateway.takeSaveLocation()).toEqual(chosen)
    expect(showDialog).toHaveBeenCalledTimes(1)

    gateway.clearSaveLocation()
    await gateway.selectDirectory()
    expect(showDialog).toHaveBeenCalledTimes(2)
    expect(showDialog.mock.calls[1]?.[0]).toMatchObject({
      defaultPath: dirname(chosen!.directory)
    })
  })

  it('重开后仍能读到上次保存位置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'save-location-'))
    const project = join(root, 'works', 'story')
    await mkdir(project, { recursive: true })
    const userDirectory = join(root, 'app')
    const showDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: [project] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const first = new ElectronProjectFileDialogGatewayImpl(() => null, userDirectory, showDialog)
    const chosen = await first.chooseSaveLocation()

    const second = new ElectronProjectFileDialogGatewayImpl(() => null, userDirectory, showDialog)
    await second.selectDirectory()
    expect(showDialog.mock.calls[1]?.[0]).toMatchObject({
      defaultPath: dirname(chosen!.directory)
    })
  })
})
