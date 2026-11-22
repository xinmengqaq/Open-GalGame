// @vitest-environment jsdom

import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastHost } from '@presentation/components/ToastHost'
import { GenerationStartNotice } from '@presentation/pages/workbench/drawer/generation/GenerationStartNotice'
import { FeedbackLayer } from '@presentation/pages/workbench/shell/FeedbackLayer'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface HostProps {
  readonly notice: string | null
  readonly tab: 'current' | 'history'
}

/**
 * 模拟工作台货架：当前生成面板与历史标签同时挂载，非活动标签 hidden；
 * 启动结果卡由 WorkbenchPage 接到反馈层登记的持久通知槽位，等价于页级接线。
 * 分叉结果仍由其它动作写入同一个 Toaster，确保这里验证的是真实共存。
 */
function Host({ notice, tab }: HostProps): ReactElement {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return createElement(
    'div',
    null,
    createElement(
      'section',
      { 'data-panel': 'current', hidden: tab !== 'current' },
      createElement('span', null, '当前生成面板')
    ),
    createElement(
      'section',
      { 'data-panel': 'history', hidden: tab !== 'history' },
      createElement('span', null, 'AI 历史')
    ),
    createElement(FeedbackLayer, { topOffset: 64, onNoticeSlotChange: setSlot }),
    createElement(GenerationStartNotice, { notice, slot }),
    createElement(ToastHost)
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve()
    /* sonner 用 setTimeout(0) 发布 toast，反馈层再用 requestAnimationFrame 量高度。 */
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20)
    for (let index = 0; index < 30; index += 1) await Promise.resolve()
  })
}

function toastTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')].map(
    (element) => element.textContent ?? ''
  )
}

function startNotice(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="generation-start-notice"]')
}

const failureNotice = '刚才的启动请求没有成功：当前场景已有进行中的生成，先完成或结束它'
const unknownNotice =
  '刚才的启动请求结果待确认，生成可能已经开始；没有自动切换视图，请刷新历史核对。'
const forkNotice = '已从「11-22 04:25 · 候选已发布，等待审阅」创建新分支'

describe('启动结果通知宿主', () => {
  const mounted: { unmount: () => Promise<void> }[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await act(async () => {
      toast.dismiss()
    })
    await flush()
    while (mounted.length > 0) await mounted.pop()?.unmount()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  async function mountHost(): Promise<{
    update: (next: HostProps) => Promise<void>
  }> {
    let props: HostProps = { notice: null, tab: 'current' }
    const Probe = (): ReactElement => createElement(Host, props)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(Probe))
    })
    await flush()
    mounted.push({
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    })
    return {
      update: async (next) => {
        props = next
        await act(async () => {
          root.render(createElement(Probe))
        })
        await flush()
      }
    }
  }

  async function showForkSuccess(): Promise<void> {
    await act(async () => {
      toast.success(forkNotice, {
        id: 'generation-fork-success',
        description: '原记录和正式作品保持不变，已切换到新分支。',
        duration: 8000
      })
    })
    await flush()
  }

  async function click(element: Element): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
  }

  it('历史标签打开时启动结果仍可读，切到当前视图也不抹掉', async () => {
    const host = await mountHost()

    await host.update({ notice: failureNotice, tab: 'history' })
    expect(startNotice()?.textContent).toContain('启动结果')
    expect(startNotice()?.textContent).toContain(failureNotice)
    expect(startNotice()?.closest('[data-sonner-toast]')).toBeNull()
    expect(
      document.querySelector('[data-testid="workbench-feedback"]')?.contains(startNotice())
    ).toBe(true)

    await host.update({ notice: failureNotice, tab: 'current' })
    expect(startNotice()?.textContent).toContain(failureNotice)
  })

  it('分叉成功 toast 与启动结果同屏共存，两者互不替换', async () => {
    const host = await mountHost()

    await host.update({ notice: failureNotice, tab: 'history' })
    await showForkSuccess()

    const card = startNotice()
    const toaster = document.querySelector('[data-sonner-toaster]')
    const forkToast = [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')].find(
      (element) => element.textContent?.includes(forkNotice) ?? false
    )

    expect(toaster?.getAttribute('data-x-position')).toBe('center')
    expect(card?.textContent).toContain(failureNotice)
    expect(forkToast).toBeTruthy()
    expect(forkToast?.contains(card ?? null)).toBe(false)
    expect(toastTexts().some((text) => text.includes(failureNotice))).toBe(false)

    await host.update({ notice: null, tab: 'history' })
    expect(startNotice()).toBeNull()
    expect(toastTexts().some((text) => text.includes(forkNotice))).toBe(true)
  })

  it('同一启动结果只保留一条，收起后同一结果再次发生仍会重新出现', async () => {
    const host = await mountHost()

    await host.update({ notice: failureNotice, tab: 'history' })
    await host.update({ notice: unknownNotice, tab: 'history' })
    expect(document.querySelectorAll('[data-testid="generation-start-notice"]')).toHaveLength(1)
    expect(startNotice()?.textContent).toContain(unknownNotice)
    expect(startNotice()?.textContent).not.toContain(failureNotice)

    await host.update({ notice: unknownNotice, tab: 'history' })
    expect(document.querySelectorAll('[data-testid="generation-start-notice"]')).toHaveLength(1)

    const dismiss = document.querySelector('button[aria-label="关闭启动结果提示"]')
    expect(dismiss).not.toBeNull()
    await click(dismiss as Element)
    expect(startNotice()).toBeNull()

    await host.update({ notice: unknownNotice, tab: 'current' })
    expect(startNotice()).toBeNull()

    await host.update({ notice: null, tab: 'history' })
    await host.update({ notice: unknownNotice, tab: 'current' })
    expect(document.querySelectorAll('[data-testid="generation-start-notice"]')).toHaveLength(1)

    await host.update({ notice: null, tab: 'current' })
    expect(startNotice()).toBeNull()
  })

  it('未知结果只标为启动结果和待确认，不冒充失败也不提供盲重试', async () => {
    const host = await mountHost()

    await host.update({ notice: unknownNotice, tab: 'current' })

    const card = startNotice()
    expect(card?.textContent).toContain('启动结果')
    expect(card?.textContent).toContain('待确认')
    expect(card?.textContent).not.toContain('没有成功')
    expect(card?.getAttribute('title')).toBe(unknownNotice)
    expect(
      [...document.querySelectorAll('button')].some((button) =>
        (button.textContent ?? '').includes('重试')
      )
    ).toBe(false)
  })
})
