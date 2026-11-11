import { describe, expect, it, vi } from 'vitest'

import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'
import {
  exportNoticeOf,
  exportRequestOf,
  formatExportBytes,
  openExportDirectory
} from '@presentation/pages/workbench/shell/sceneTaskPresentation'

const saved = {
  requestId: 'request-saved',
  contentBasis: { digest: 'content-digest', parserVersion: '4.6.5', engineVersion: '4.6.5' }
}

const directoryPath =
  'D:\\daimai\\galgame ai协作\\docs\\素材目录\\real-acceptance\\userhome\\exports\\scene-output'

describe('工作台场景工具呈现', () => {
  it('导出只使用保存身份、内容依据和预览保存引用', () => {
    const request = exportRequestOf('project-1', 'scene-1', saved)

    expect(request).toEqual({
      projectId: 'project-1',
      sceneId: 'scene-1',
      contentBasis: saved.contentBasis,
      versionReference: { kind: 'preview-save', requestId: 'request-saved' }
    })
    expect(Object.keys(request).sort()).toEqual([
      'contentBasis',
      'projectId',
      'sceneId',
      'versionReference'
    ])
    expect(JSON.stringify(request)).not.toMatch(/candidate|draft|path|stageUrl/i)
  })

  it('导出成功带出产物绝对路径，进行中不当作成功', () => {
    expect(
      exportNoticeOf({
        status: 'succeeded',
        artifact: {
          executableName: 'WebGAL.exe',
          directoryName: 'scene-output',
          directoryPath,
          bytes: 2_621_440,
          containsFixedEngine: true,
          entryRelativePath: 'game/scene/start.txt',
          contentBasis: saved.contentBasis,
          versionReference: { kind: 'preview-save', requestId: saved.requestId }
        }
      })
    ).toEqual({
      tone: 'ok',
      label: '已导出',
      detail: '已生成 WebGAL.exe（2.5 MB）',
      directoryPath
    })
    expect(exportNoticeOf({ status: 'exporting' })).toMatchObject({
      tone: 'warning',
      label: '导出未完成'
    })
    expect(exportNoticeOf({ status: 'failed', message: '打包失败' })).toEqual({
      tone: 'danger',
      label: '导出失败',
      detail: '打包失败'
    })
    expect(
      exportNoticeOf({
        status: 'unavailable',
        reason: 'windowsPackagerUnavailable',
        message: '当前没有可调用的 Windows 桌面打包入口'
      })
    ).toEqual({
      tone: 'warning',
      label: '暂不可用',
      detail: '当前没有可调用的 Windows 桌面打包入口'
    })
  })

  it('打开产物目录只把绝对路径交给 client', async () => {
    const openDirectory = vi.fn(async () => ({ code: 2000, msg: '已打开目录', data: null }))
    const client: Pick<SceneExportClient, 'openDirectory'> = { openDirectory }

    await openExportDirectory(client, directoryPath)

    expect(openDirectory).toHaveBeenCalledTimes(1)
    expect(openDirectory).toHaveBeenCalledWith({ path: directoryPath })
  })

  it('打开产物目录失败时不吞错误', async () => {
    const client: Pick<SceneExportClient, 'openDirectory'> = {
      openDirectory: vi.fn(async () => ({ code: 4101, msg: '不允许打开该目录' }))
    }

    await expect(openExportDirectory(client, directoryPath)).rejects.toThrow('不允许打开该目录')
  })

  it('文件大小只用于展示，极小文件也显示为 1 KB 以上', () => {
    expect(formatExportBytes(500)).toBe('1 KB')
    expect(formatExportBytes(20_480)).toBe('20 KB')
    expect(formatExportBytes(1_048_576)).toBe('1.0 MB')
  })
})
