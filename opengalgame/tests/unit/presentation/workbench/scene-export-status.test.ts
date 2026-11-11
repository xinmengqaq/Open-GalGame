import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  SceneExportOpenDirectory,
  SceneExportStatus,
  openDirectoryFailureNote
} from '@presentation/pages/workbench/shell/SceneExportStatus'

const directoryPath =
  'D:\\daimai\\galgame ai协作\\docs\\素材目录\\real-acceptance\\userhome\\exports\\scene-1'

describe('SceneExportStatus', () => {
  it('导出成功时显示产物绝对路径与打开按钮', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportStatus, {
        notice: {
          tone: 'ok',
          label: '已导出',
          detail: '已生成 WebGAL.exe（168.2 MB）',
          directoryPath
        },
        onDismiss: () => undefined,
        onOpenDirectory: async () => undefined
      })
    )

    expect(html).toContain('已导出')
    expect(html).toContain('已导出到：')
    expect(html).toContain(directoryPath)
    expect(html).toContain('打开所在文件夹')
    expect(html).toContain('data-expanded="true"')
    expect(html).not.toContain('正在打开…')
  })

  it('无法打开文件夹的提示能由组件展示', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportOpenDirectory, {
        directoryPath,
        opening: false,
        error: openDirectoryFailureNote,
        onOpen: () => undefined,
        onDismiss: () => undefined
      })
    )

    expect(html).toContain(directoryPath)
    expect(html).toContain('打开所在文件夹')
    expect(html).toContain(openDirectoryFailureNote)
    expect(html).toContain('role="alert"')
  })

  it('打开中禁用按钮并显示正在打开…', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportOpenDirectory, {
        directoryPath,
        opening: true,
        error: null,
        onOpen: () => undefined,
        onDismiss: () => undefined
      })
    )

    expect(html).toContain('正在打开…')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('打开所在文件夹')
  })

  it('进行中状态不显示路径与打开动作', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportStatus, {
        notice: { tone: 'busy', label: '导出中', detail: '正在打包当前场景。' },
        onDismiss: () => undefined,
        onOpenDirectory: async () => undefined
      })
    )

    expect(html).toContain('导出中')
    expect(html).not.toContain('已导出到：')
    expect(html).not.toContain('打开所在文件夹')
    expect(html).not.toContain('data-expanded')
  })
})
