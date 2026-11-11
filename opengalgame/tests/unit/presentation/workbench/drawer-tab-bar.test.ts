import { readFileSync } from 'node:fs'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Popover, PopoverContent, PopoverTrigger } from '@presentation/components/ui/popover'
import { POPOVER_Z_INDEX, resolvePopoverPortal } from '@presentation/components/ui/popoverPortal'
import {
  DrawerTabBar,
  type DrawerTabBarProps
} from '@presentation/pages/workbench/drawer/DrawerTabBar'

const BASE_PROPS: DrawerTabBarProps = {
  tabs: ['current', 'summary', 'history'],
  activeId: 'summary',
  candidateAvailable: false,
  onActivate: () => undefined,
  onClose: () => undefined,
  onReorder: () => undefined,
  onOpenView: () => undefined
}

function renderBar(overrides: Partial<DrawerTabBarProps> = {}): string {
  return renderToStaticMarkup(createElement(DrawerTabBar, { ...BASE_PROPS, ...overrides }))
}

function countOf(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0
}

describe('DrawerTabBar 静态结构', () => {
  it('渲染一条 tablist，活动标签唯一选中，当前生成不可关闭', () => {
    const html = renderBar()

    expect(countOf(html, /role="tablist"/g)).toBe(1)
    expect(countOf(html, /role="tab"/g)).toBe(3)
    expect(countOf(html, /aria-selected="true"/g)).toBe(1)
    expect(countOf(html, /aria-selected="false"/g)).toBe(2)
    expect(countOf(html, /tabindex="0"/g)).toBe(1)

    expect(html).toContain('id="wb-drawer-tab-summary"')
    expect(html).toContain('aria-controls="wb-drawer-view-summary"')
    expect(html).toContain('aria-keyshortcuts="Delete Shift+F10"')

    expect(html).toContain('aria-label="关闭“输入摘要”"')
    expect(html).toContain('aria-label="关闭“AI 历史”"')
    expect(html).not.toContain('关闭“当前生成”')
    expect(html).toContain('aria-label="打开其他视图"')

    /* 两个可关闭标签各有一个菜单，`+` 入口另有自己的 Popover 触发按钮。 */
    expect(countOf(html, /aria-haspopup="menu"/g)).toBe(3)
    expect(countOf(html, /aria-expanded="false"/g)).toBe(3)

    const currentButton = html.match(/<button[^>]*id="wb-drawer-tab-current"[^>]*>/)?.[0] ?? ''
    expect(currentButton).not.toBe('')
    expect(currentButton).not.toContain('aria-haspopup')
    expect(currentButton).not.toContain('aria-expanded')
    expect(currentButton).not.toContain('aria-keyshortcuts')

    const summaryButton = html.match(/<button[^>]*id="wb-drawer-tab-summary"[^>]*>/)?.[0] ?? ''
    expect(summaryButton).toContain('aria-haspopup="menu"')
    expect(summaryButton).toContain('aria-expanded="false"')
    expect(summaryButton).toContain('aria-keyshortcuts="Delete Shift+F10"')
  })

  it('关闭按钮与标签按钮同级，不在标签按钮内部', () => {
    const html = renderBar()

    const tabStart = html.indexOf('aria-label="输入摘要"')
    const tabEnd = html.indexOf('</button>', tabStart)
    const closeStart = html.indexOf('aria-label="关闭“输入摘要”"')
    expect(tabStart).toBeGreaterThan(-1)
    expect(tabEnd).toBeGreaterThan(tabStart)
    expect(closeStart).toBeGreaterThan(tabEnd)
  })

  it('浮层菜单在关闭状态不渲染内容', () => {
    const html = renderBar()
    expect(html).not.toContain('role="menu"')
    expect(html).not.toContain('左移')
    expect(html).not.toContain('右移')
  })
})

describe('DrawerTabBar 真实状态投影', () => {
  it('候选角标来自传入的读取问题数，未读取时显示活动点', () => {
    const withCount = renderBar({
      activeId: 'candidate',
      candidateAvailable: true,
      candidateBadge: { count: 2, live: false },
      tabs: ['current', 'candidate']
    })
    expect(withCount).toMatch(/wb-drawertab__badge[^>]*>2</)
    expect(withCount).toContain('2 个读取问题')
    expect(withCount).not.toContain('wb-drawertab__live')

    const reading = renderBar({
      activeId: 'candidate',
      candidateAvailable: true,
      candidateBadge: { count: 0, live: true },
      tabs: ['current', 'candidate']
    })
    expect(reading).toContain('wb-drawertab__live')
    expect(reading).toContain('正在读取游戏画面')
    expect(reading).not.toContain('wb-drawertab__badge')
  })

  it('候选角标只反映读取结果，不参与候选入口可用性', () => {
    const unavailableButRead = renderBar({
      activeId: 'candidate',
      candidateAvailable: false,
      candidateBadge: { count: 3, live: false },
      tabs: ['current', 'candidate']
    })
    expect(unavailableButRead).toMatch(/wb-drawertab__badge[^>]*>3</)
    expect(unavailableButRead).toContain('3 个读取问题')

    const availableWithoutFacts = renderBar({
      candidateAvailable: true,
      candidateBadge: null,
      tabs: ['current', 'summary']
    })
    expect(availableWithoutFacts).not.toContain('wb-drawertab__badge')
    expect(availableWithoutFacts).not.toContain('wb-drawertab__live')
  })

  it('当前生成的状态点按任务状态区分，不只靠颜色', () => {
    const running = renderBar({ currentTone: 'running' })
    expect(running).toContain('data-tone="running"')
    expect(running).toContain('当前生成，进行中')

    const waiting = renderBar({ currentTone: 'waiting' })
    expect(waiting).toContain('data-tone="waiting"')
    expect(waiting).toContain('当前生成，等待你回复')

    const pendingVerification = renderBar({ currentTone: 'pendingVerification' })
    expect(pendingVerification).toContain('data-tone="pendingVerification"')
    expect(pendingVerification).toContain('当前生成，结果待核对')
    expect(pendingVerification).not.toContain('生成失败')

    const noTone = renderBar()
    expect(noTone).not.toContain('wb-drawertab__tone')
  })

  it('作品历史写操作在途时关闭按钮禁用并说明原因', () => {
    const busy = renderBar({
      activeId: 'works',
      tabs: ['current', 'works'],
      worksBusy: true
    })
    expect(busy).toMatch(/aria-label="关闭“作品历史”"[^>]*disabled/)
    expect(busy).toContain('正在处理历史操作，完成后才能关闭')

    const idle = renderBar({ activeId: 'works', tabs: ['current', 'works'] })
    expect(idle).toMatch(/aria-label="关闭“作品历史”"/)
    expect(idle).not.toMatch(/aria-label="关闭“作品历史”"[^>]*disabled/)
  })
})

describe('Popover 基座', () => {
  it('层级在 Sheet 内容之上，SSR 无 document 时不访问页面', () => {
    expect(POPOVER_Z_INDEX).toBeGreaterThan(50)
    expect(resolvePopoverPortal()).toBeNull()
  })

  it('关闭状态只渲染触发按钮，不渲染浮层内容', () => {
    const html = renderToStaticMarkup(
      createElement(
        Popover,
        null,
        createElement(PopoverTrigger, null, '打开视图'),
        createElement(PopoverContent, null, '浮层内容')
      )
    )

    expect(html).toContain('打开视图')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('浮层内容')
  })

  it('按抽屉、body 和显式容器解析 portal 目标', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const drawer = { kind: 'drawer' }
    const body = { kind: 'body' }
    const explicit = { kind: 'explicit' }

    function withDocument(querySelector: (selector: string) => unknown, run: () => void): void {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { body, querySelector }
      })
      try {
        run()
      } finally {
        if (original) Object.defineProperty(globalThis, 'document', original)
        else Reflect.deleteProperty(globalThis, 'document')
      }
    }

    withDocument(
      (selector) => (selector === '.wb-drawer' ? drawer : null),
      () => {
        expect(resolvePopoverPortal()).toEqual({ container: drawer, themed: false })
        expect(resolvePopoverPortal(explicit as unknown as HTMLElement)).toEqual({
          container: explicit,
          themed: false
        })
      }
    )

    withDocument(
      () => null,
      () => {
        expect(resolvePopoverPortal()).toEqual({ container: body, themed: true })
      }
    )
  })

  it('包装层不提供默认背景、圆角和阴影', () => {
    const source = readFileSync(
      new URL('../../../../src/presentation/components/ui/popover.tsx', import.meta.url),
      'utf8'
    )

    expect(source).not.toMatch(/bg-popover|text-popover-foreground/)
    expect(source).not.toMatch(/rounded-(?:sm|md|lg|xl|full)/)
    expect(source).not.toMatch(/shadow-(?:sm|md|lg|xl)/)
  })
})

describe('drawerTabs.css 冻结视觉约束', () => {
  const css = readFileSync(
    new URL('../../../../src/presentation/pages/workbench/drawer/drawerTabs.css', import.meta.url),
    'utf8'
  )
  const themeCss = readFileSync(
    new URL(
      '../../../../src/presentation/pages/workbench/workbenchTheme.module.css',
      import.meta.url
    ),
    'utf8'
  )
  const tokensCss = readFileSync(
    new URL('../../../../src/presentation/effects/tokens.css', import.meta.url),
    'utf8'
  )
  const SPACING = new Set([0, 4, 8, 12, 16, 24, 32])

  function declaredProperties(source: string): Set<string> {
    return new Set(
      [...source.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1].toLowerCase())
    )
  }

  function referencedProperties(source: string): string[] {
    return [...source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1].toLowerCase())
  }

  it('不覆盖 drawer.css 的旧标签规则，不新增全局变量或第二主题', () => {
    expect(css).not.toMatch(/\.wb-drawer__tab\b/)
    expect(css).not.toMatch(/:root\b/)
    expect(css).not.toMatch(/^\s*--[a-z0-9-]+\s*:/gim)
  })

  it('颜色只来自 --wb-* 与 tokens.css，不写裸 hex、rgb/hsl 或命名颜色', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/)
    expect(css).not.toMatch(
      /:\s*(?:white|black|red|green|blue|gray|grey|silver|maroon|olive|lime|aqua|teal|navy|fuchsia|purple|orange|yellow|pink|brown|gold|beige|ivory|khaki|coral|salmon|orchid|plum|tan|azure|lavender)\b/i
    )

    const allowed = new Set([...declaredProperties(themeCss), ...declaredProperties(tokensCss)])
    const used = referencedProperties(css)
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) {
      expect(allowed.has(name), `${name} 不在 --wb-* 或 tokens.css 中`).toBe(true)
    }
  })

  it('字体只取工作台字体变量', () => {
    const families = [...css.matchAll(/font-family\s*:\s*([^;}]+)/g)].map((match) =>
      match[1].trim()
    )
    expect(families.length).toBeGreaterThan(0)
    for (const family of families) {
      expect(['var(--wb-font)', 'var(--wb-font-mono)']).toContain(family)
    }
  })

  it('布局间距只用 4/8/12/16/24/32，2px 只留给线条和指示线', () => {
    const declarations = [
      ...css.matchAll(
        /(?:^|[;{])\s*(margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g
      )
    ]
    expect(declarations.length).toBeGreaterThan(0)
    for (const [, property, raw] of declarations) {
      for (const part of raw.trim().split(/\s+/)) {
        if (part === 'auto' || part.startsWith('var(')) continue
        const px = /^(-?\d+(?:\.\d+)?)px$/.exec(part)
        if (!px) continue
        const value = Number(px[1])
        expect(SPACING.has(value), `${property}: ${raw} 使用了 ${value}px`).toBe(true)
      }
    }
  })

  it('活动标签用 2px 强调线，不是 1px 白线', () => {
    const accent = css.match(/\[data-active='true'\]::after\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(accent).toMatch(/height:\s*2px/)
    expect(accent).toMatch(/background:\s*var\(--wb-accent\)/)
    expect(css).not.toContain('255 253 251')

    const close = css.match(/\.wb-drawertab__close\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(close).toContain('opacity: 0.45')
  })
})
