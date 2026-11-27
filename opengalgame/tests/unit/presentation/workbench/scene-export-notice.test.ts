// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SystemPathErrorCodes } from '@domain/system-path/errors/SystemPathErrorCodes'
import {
  openDirectoryFailureInstruction,
  openDirectoryUnsupportedInstruction,
  SceneExportNoticeCard
} from '@presentation/pages/workbench/shell/SceneExportNotice'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const directoryPath =
  'D:\\daimai\\galgame ai协作\\docs\\素材目录\\real-acceptance\\userhome\\exports\\scene-1'

function exportedNotice() {
  return {
    tone: 'ok' as const,
    label: '已导出',
    detail: '已生成 WebGAL.exe（168.2 MB）',
    directoryPath
  }
}

describe('SceneExportNoticeCard', () => {
  it('导出成功时只呈现一个浮层，含完整路径、打开动作与收起入口', () => {
    const html = renderToStaticMarkup(
      createElement(SceneExportNoticeCard, {
        notice: exportedNotice(),
        onDismiss: () => undefined,
        onOpenDirectory: async () => '目录已交给系统打开'
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
        onOpenDirectory: async () => '目录已交给系统打开'
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

describe('SceneExportNoticeCard 打开目录反馈', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function mount(
    onOpenDirectory: (path: string) => Promise<string>
  ): Promise<void> {
    await act(async () => {
      root.render(
        createElement(SceneExportNoticeCard, {
          notice: exportedNotice(),
          onDismiss: () => undefined,
          onOpenDirectory
        }) as ReactElement
      )
    })
  }

  function openButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      /打开所在文件夹|正在打开…|当前环境不能打开/u.test(candidate.textContent ?? '')
    )
    if (button === undefined) throw new Error('未找到打开目录按钮')
    return button as HTMLButtonElement
  }

  async function clickOpen(): Promise<void> {
    await act(async () => {
      openButton().click()
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })
  }

  it('成功后显示“已交给系统”的请求结果，不冒充已确认打开', async () => {
    const onOpenDirectory = vi.fn(async () => '目录已交给系统打开')
    await mount(onOpenDirectory)

    await clickOpen()

    expect(onOpenDirectory).toHaveBeenCalledWith(directoryPath)
    expect(container.textContent).toContain('目录已交给系统打开；请到系统窗口中查看')
    expect(container.querySelector('[data-state="opened"]')).not.toBeNull()
    expect(openButton().disabled).toBe(false)
    expect(openButton().textContent).toContain('打开所在文件夹')
  })

  it('失败时保留具体原因，并提示手动打开路径', async () => {
    const onOpenDirectory = vi.fn(async () => {
      throw new AppException({
        code: SystemPathErrorCodes.pathRejected,
        msg: '只能打开本机已有的目录'
      })
    })
    await mount(onOpenDirectory)

    await clickOpen()

    const alert = container.querySelector('[data-state="failed"][role="alert"]')
    expect(alert?.textContent).toContain(`只能打开本机已有的目录；${openDirectoryFailureInstruction}`)
    expect(container.textContent).not.toContain('已交给系统打开')
    expect(openButton().disabled).toBe(false)
  })

  it('当前环境不支持时给出明确说明并禁用打开动作', async () => {
    const onOpenDirectory = vi.fn(async () => {
      throw new AppException({
        code: ErrorCodes.forbidden,
        msg: '当前环境不能打开本机目录'
      })
    })
    await mount(onOpenDirectory)

    await clickOpen()

    expect(container.textContent).toContain(
      `当前环境不能打开本机目录；${openDirectoryUnsupportedInstruction}`
    )
    expect(container.querySelector('[data-state="unsupported"]')).not.toBeNull()
    expect(container.textContent).not.toContain('已交给系统打开')
    expect(openButton().disabled).toBe(true)
    expect(openButton().textContent).toContain('当前环境不能打开')
  })
})
