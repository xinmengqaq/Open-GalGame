import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SceneExportNoticeCard } from '@presentation/pages/workbench/shell/SceneExportNotice'

const directoryPath =
  'D:\\daimai\\galgame ai协作\\docs\\素材目录\\real-acceptance\\userhome\\exports\\scene-1'

describe('SceneExportNoticeCard', () => {
  it('导出成功时只呈现一个浮层，含完整路径、打开动作与收起入口', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportNoticeCard, {
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

    expect(html).toContain('data-testid="scene-export-notice"')
    expect(html).toContain('role="status"')
    expect(html).toContain('已导出')
    expect(html).toContain('产物位置')
    expect(html).toContain(directoryPath)
    expect(html).toContain('打开所在文件夹')
    expect(html).toContain('aria-label="收起导出结果"')
    expect(html).not.toContain('正在打开…')
  })

  it('进行中状态不显示路径、打开动作和收起入口', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportNoticeCard, {
        notice: { tone: 'busy', label: '导出中', detail: '正在打包当前场景。' },
        onDismiss: () => undefined,
        onOpenDirectory: async () => undefined
      })
    )

    expect(html).toContain('导出中')
    expect(html).toContain('正在打包当前场景。')
    expect(html).not.toContain('产物位置')
    expect(html).not.toContain('打开所在文件夹')
    expect(html).not.toContain('收起导出结果')
  })

  it('失败状态使用 alert 语义并保留可读原因', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportNoticeCard, {
        notice: {
          tone: 'danger',
          label: '导出失败',
          detail: '工程内容已变化，请重新保存后再导出。'
        },
        onDismiss: () => undefined
      })
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('导出失败')
    expect(html).toContain('工程内容已变化')
    expect(html).toContain('收起导出结果')
    expect(html).not.toContain('产物位置')
  })
})
