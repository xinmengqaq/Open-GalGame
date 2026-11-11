import { createContext, runInContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { stageInputPage } from '@infrastructure/webgal/compatibility/BrowserStageTrustedInput'

const origin = 'http://127.0.0.1:41000'

type StageFacts = { languageButtons: unknown[]; titleButtons: unknown[] } | null

function probe(frame: {
  readyState: string
  width: number
  height: number
  buttons?: ReadonlyArray<{ text: string; className: string }>
}): { facts: () => StageFacts; clickText: (text: string) => boolean } {
  const clicks: string[] = []
  const elements = (frame.buttons ?? []).map((button) => ({
    className: button.className,
    textContent: button.text,
    getBoundingClientRect: () => ({ width: 40, height: 20 }),
    click: () => clicks.push(button.text)
  }))
  const contentDocument = {
    readyState: frame.readyState,
    documentElement: { clientWidth: frame.width, clientHeight: frame.height },
    querySelectorAll: (selector: string) =>
      elements.filter((element) =>
        selector.includes('Title_button')
          ? element.className.includes('Title_button')
          : element.className.includes('langSelectButton')
      )
  }
  const contentWindow = {
    innerWidth: frame.width,
    innerHeight: frame.height,
    location: { href: `${origin}/` },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto' })
  }
  const sandbox = createContext({
    document: {
      querySelector: () => ({
        contentWindow,
        contentDocument,
        addEventListener: () => undefined
      })
    },
    location: { pathname: '/stage' },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ done: true }) }),
    setTimeout,
    JSON
  })
  const script = stageInputPage(origin).match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error('舞台包装页没有脚本')
  runInContext(`${script}\n;this.__facts = facts; this.__clickText = clickText`, sandbox)
  return {
    facts: () => (sandbox.__facts as () => StageFacts)(),
    clickText: (text) =>
      (sandbox.__clickText as (value: string) => boolean)(text) && clicks.includes(text)
  }
}

describe('浏览器舞台包装页', () => {
  it('内部游戏未就绪或视口为零时返回空事实，就绪后才读取并点击', () => {
    const hidden = probe({ readyState: 'loading', width: 0, height: 0 })
    expect(hidden.facts()).toBeNull()
    expect(hidden.clickText('开始游戏')).toBe(false)

    const ready = probe({
      readyState: 'complete',
      width: 1280,
      height: 720,
      buttons: [{ text: '开始游戏', className: 'Title_button_start' }]
    })
    expect(ready.facts()).toMatchObject({
      titleButtons: [{ text: '开始游戏' }]
    })
    expect(ready.clickText('开始游戏')).toBe(true)
  })
})
