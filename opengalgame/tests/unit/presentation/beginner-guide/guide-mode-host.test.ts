// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerPageModal } from '@presentation/components/dialogElement'
import { BeginnerGuideHost } from '@presentation/features/beginner-guide/BeginnerGuideHost'
import {
  readGuidePreferences,
  writeGuidePreferences
} from '@presentation/features/beginner-guide/guidePreferences'
import type {
  GuideContextSnapshot,
  GuideFact,
  GuideObservationSource
} from '@presentation/features/beginner-guide/guideObservation'
import {
  setGuidePreviewHost,
  setGuideTopLayerHost
} from '@presentation/features/beginner-guide/guideTopLayer'
import { TEST_SCOPE } from './guideFacts'

vi.mock('@presentation/features/beginner-guide/useGuideMotion', () => ({
  useGuideOverlayMotion: () => undefined,
  useGuideConnectionMotion: () => undefined
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('matchMedia', () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined
}))
HTMLDialogElement.prototype.showModal = function () {
  this.open = true
}
HTMLDialogElement.prototype.close = function () {
  this.open = false
}
class TestResizeObserver {
  observe(): void {
    return undefined
  }
  unobserve(): void {
    return undefined
  }
  disconnect(): void {
    return undefined
  }
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

const WORKBENCH: GuideContextSnapshot = {
  page: 'workbench',
  projectId: TEST_SCOPE.projectId,
  sceneId: TEST_SCOPE.sceneId,
  canvasId: TEST_SCOPE.canvasId,
  documentLayerCardId: null,
  saveState: 'saved',
  arrangementStatus: 'ready',
  previewOpen: false,
  generationDrawerOpen: false,
  mediaAvailability: { image: true, audio: true, video: false },
  cardTitles: {}
}

class FakeGuideSource implements GuideObservationSource {
  private snapshot: GuideContextSnapshot
  private readonly factListeners = new Set<(nextFact: GuideFact) => void>()
  private readonly contextListeners = new Set<(snapshot: GuideContextSnapshot) => void>()
  private readonly previewListeners = new Set<(open: boolean) => void>()

  constructor(snapshot: GuideContextSnapshot) {
    this.snapshot = snapshot
  }

  readCurrent(): GuideContextSnapshot {
    return this.snapshot
  }

  subscribe(listener: (nextFact: GuideFact) => void): () => void {
    this.factListeners.add(listener)
    return () => {
      this.factListeners.delete(listener)
    }
  }

  subscribeContext(listener: (snapshot: GuideContextSnapshot) => void): () => void {
    this.contextListeners.add(listener)
    return () => {
      this.contextListeners.delete(listener)
    }
  }

  subscribePreview(listener: (open: boolean) => void): () => void {
    this.previewListeners.add(listener)
    return () => {
      this.previewListeners.delete(listener)
    }
  }

  setSnapshot(next: GuideContextSnapshot): void {
    const previewChanged = next.previewOpen !== this.snapshot.previewOpen
    this.snapshot = next
    for (const listener of [...this.contextListeners]) listener(next)
    if (previewChanged) {
      for (const listener of [...this.previewListeners]) listener(next.previewOpen)
    }
  }
}

const mounted: Array<() => Promise<void>> = []
let root: Root | null = null

beforeEach(() => {
  window.localStorage.clear()
  writeGuidePreferences({
    version: 1,
    invitationHandled: true,
    tutorialModeActive: true,
    lastStepId: 'polish-dialogue',
    lastBeatId: null,
    entryHidden: false
  })
})

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.()
  setGuideTopLayerHost(null)
  setGuidePreviewHost(null)
  window.localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve()
  })
}

async function mountHost(
  source: FakeGuideSource,
  page: 'home' | 'projects' | 'workbench' = 'workbench',
  restoreEntryRequest = 0
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      createElement(BeginnerGuideHost, {
        page,
        restoreEntryRequest,
        observationSource: source,
        importMedia: async () => 'unavailable' as const
      })
    )
  })
  await flush()
  mounted.push(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    container.remove()
  })
}

async function unmountHost(): Promise<void> {
  const unmount = mounted.pop()
  if (unmount) await unmount()
}

function buttonWith(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`没有找到按钮：${text}`)
  return button
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.click()
  })
  await flush()
}

async function setSnapshot(source: FakeGuideSource, next: GuideContextSnapshot): Promise<void> {
  await act(async () => {
    source.setSnapshot(next)
  })
  await flush()
}

describe('教程模式固定与退出入口', () => {
  it('刷新恢复开启与第 7 步；抽屉、预览切换不收起浮窗', async () => {
    const drawerSlot = document.createElement('div')
    drawerSlot.setAttribute('data-guide-top-layer-host', 'drawer')
    document.body.appendChild(drawerSlot)
    setGuideTopLayerHost(drawerSlot)
    const previewSlot = document.createElement('div')
    previewSlot.setAttribute('data-guide-top-layer-host', 'preview')
    document.body.appendChild(previewSlot)
    setGuidePreviewHost(previewSlot)

    const source = new FakeGuideSource(WORKBENCH)
    await mountHost(source)

    expect(document.body.textContent).toContain('第 7 / 8 步')
    expect(document.body.textContent).toContain('在试玩预览里改一句')
    expect(document.querySelector('[data-guide-entry]')).toBeNull()
    expect(
      document.querySelector('[data-guide-overlay="expanded"]')?.getAttribute('data-guide-layout')
    ).toBe('default')

    await setSnapshot(source, { ...WORKBENCH, generationDrawerOpen: true })
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.querySelector('[data-guide-overlay="collapsed"]')).toBeNull()
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(drawerSlot)

    await setSnapshot(source, { ...WORKBENCH, previewOpen: true })
    const previewOverlay = document.querySelector('[data-guide-overlay="expanded"]')
    expect(previewOverlay).not.toBeNull()
    expect(previewOverlay?.getAttribute('data-guide-layout')).toBe('preview')
    expect(document.body.textContent).toContain('选一句，改成新台词')
    expect(document.body.textContent).toContain('在左侧点一句对白')
    expect(document.body.textContent).not.toContain('打开「试玩预览」')
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(previewSlot)

    await setSnapshot(source, WORKBENCH)
    expect(
      document.querySelector('[data-guide-overlay="expanded"]')?.getAttribute('data-guide-layout')
    ).toBe('default')
  })

  it('折叠胶囊可展开也可退出，退出后无浮窗高亮但保留入口，重启不再自动出现', async () => {
    const source = new FakeGuideSource(WORKBENCH)
    await mountHost(source)

    await click(document.querySelector<HTMLElement>('[aria-label="收起教程"]') as HTMLElement)
    expect(document.querySelector('[data-guide-overlay="expanded"]')).toBeNull()
    const collapsed = document.querySelector<HTMLButtonElement>('[data-guide-overlay="collapsed"]')
    expect(collapsed?.getAttribute('aria-label')).toContain('展开教程，第 7 步')
    const exit = document.querySelector<HTMLButtonElement>('[data-guide-exit="pill"]')
    expect(exit?.getAttribute('aria-label')).toBe('退出教程模式')
    expect(collapsed?.parentElement?.contains(exit)).toBe(true)

    await click(exit as HTMLButtonElement)
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    expect(document.querySelector('[data-guide-exit="pill"]')).toBeNull()
    expect(document.querySelectorAll('[data-guide-current]')).toHaveLength(0)
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()
    expect(readGuidePreferences().tutorialModeActive).toBe(false)
    expect(readGuidePreferences().lastStepId).toBe('polish-dialogue')

    await unmountHost()
    const restarted = new FakeGuideSource(WORKBENCH)
    await mountHost(restarted)
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    expect(document.body.textContent).not.toContain('把一段戏做成能玩的场景')
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()
    expect(document.body.textContent).toContain('第 7 步')

    await click(document.querySelector('[data-guide-entry]') as HTMLElement)
    expect(document.body.textContent).toContain('把一段戏做成能玩的场景')
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()

    await click(buttonWith('开始跟做'))
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.body.textContent).toContain('第 7 / 8 步')
    expect(readGuidePreferences().tutorialModeActive).toBe(true)
  })

  it('展开面板可退出教程，入口 × 关闭入口并持久隐藏', async () => {
    const source = new FakeGuideSource(WORKBENCH)
    await mountHost(source)

    const panelExit = document.querySelector<HTMLButtonElement>('[data-guide-exit="panel"]')
    expect(panelExit?.getAttribute('aria-label')).toBe('退出教程模式')
    await click(panelExit as HTMLButtonElement)
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()

    const entryExit = document.querySelector<HTMLButtonElement>('[data-guide-entry-exit]')
    expect(entryExit?.getAttribute('aria-label')).toBe('关闭新手教程')
    await click(entryExit as HTMLButtonElement)
    expect(document.querySelector('[data-guide-entry]')).toBeNull()
    expect(readGuidePreferences().entryHidden).toBe(true)

    await unmountHost()
    await mountHost(new FakeGuideSource(WORKBENCH))
    expect(document.querySelector('[data-guide-entry]')).toBeNull()

    await unmountHost()
    await mountHost(new FakeGuideSource(WORKBENCH), 'workbench', 1)
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    expect(readGuidePreferences().entryHidden).toBe(false)
  })

  it('预览里退出保留左下入口，接受邀请后回到第 7 步', async () => {
    const previewSlot = document.createElement('div')
    previewSlot.setAttribute('data-guide-top-layer-host', 'preview')
    document.body.appendChild(previewSlot)
    setGuidePreviewHost(previewSlot)

    const source = new FakeGuideSource({ ...WORKBENCH, previewOpen: true })
    await mountHost(source)
    expect(
      document.querySelector('[data-guide-overlay="expanded"]')?.getAttribute('data-guide-layout')
    ).toBe('preview')

    await click(buttonWith('退出跟做'))
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    const entry = document.querySelector<HTMLButtonElement>('[data-guide-entry]')
    expect(entry?.getAttribute('data-layout')).toBe('preview')
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(previewSlot)

    await click(entry as HTMLButtonElement)
    expect(document.body.textContent).toContain('把一段戏做成能玩的场景')
    await click(buttonWith('开始跟做'))
    expect(
      document.querySelector('[data-guide-overlay="expanded"]')?.getAttribute('data-guide-layout')
    ).toBe('preview')
    expect(document.body.textContent).toContain('第 7 / 8 步')
  })

  it('第 7 步预览不脉冲返回按钮', async () => {
    const previewRoot = document.createElement('div')
    previewRoot.setAttribute('data-testid', 'preview-page')
    const back = document.createElement('button')
    back.type = 'button'
    back.setAttribute('data-guide-return', 'preview')
    previewRoot.appendChild(back)
    document.body.appendChild(previewRoot)

    const source = new FakeGuideSource({ ...WORKBENCH, previewOpen: true })
    await mountHost(source)
    expect(back.getAttribute('data-guide-return-guide')).toBeNull()
    expect(back.style.boxShadow).toBe('')
  })

  it('第 8 步在预览里脉冲真实返回按钮，点击后清理内联样式', async () => {
    writeGuidePreferences({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: 'export-build',
      lastBeatId: null,
      entryHidden: false
    })
    const previewRoot = document.createElement('div')
    previewRoot.setAttribute('data-testid', 'preview-page')
    const back = document.createElement('button')
    back.type = 'button'
    back.setAttribute('data-guide-return', 'preview')
    back.setAttribute('data-guide-target', 'preview-return')
    back.textContent = '返回工作台'
    previewRoot.appendChild(back)
    document.body.appendChild(previewRoot)

    const source = new FakeGuideSource({ ...WORKBENCH, previewOpen: true })
    await mountHost(source)
    expect(document.body.textContent).toContain('先回到工作台')
    expect(back.getAttribute('data-guide-return-guide')).toBe('true')
    expect(back.style.boxShadow).not.toBe('')

    await click(back)
    expect(back.getAttribute('data-guide-return-guide')).toBeNull()
    expect(back.style.boxShadow).toBe('')
  })

  it('离开第 8 步或返回工作台后移除脉冲状态', async () => {
    writeGuidePreferences({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: 'export-build',
      lastBeatId: null,
      entryHidden: false
    })
    const previewRoot = document.createElement('div')
    previewRoot.setAttribute('data-testid', 'preview-page')
    const back = document.createElement('button')
    back.type = 'button'
    back.setAttribute('data-guide-return', 'preview')
    previewRoot.appendChild(back)
    document.body.appendChild(previewRoot)

    const source = new FakeGuideSource({ ...WORKBENCH, previewOpen: true })
    await mountHost(source)
    expect(back.getAttribute('data-guide-return-guide')).toBe('true')

    await setSnapshot(source, WORKBENCH)
    expect(back.getAttribute('data-guide-return-guide')).toBeNull()
    expect(back.style.boxShadow).toBe('')
  })

  it('退出后的入口在项目页也可发现', async () => {
    writeGuidePreferences({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: false,
      lastStepId: 'polish-dialogue',
      lastBeatId: null,
      entryHidden: false
    })
    const source = new FakeGuideSource({ ...WORKBENCH, page: 'project-list' })
    await mountHost(source, 'projects')
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()
    expect(document.body.textContent).toContain('第 7 步')
  })

  it('原生模态打开时浮窗照常工作，入口等模态关闭后再出现', async () => {
    const source = new FakeGuideSource(WORKBENCH)
    await mountHost(source)
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()

    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    let unregister: (() => void) | null = null
    await act(async () => {
      unregister = registerPageModal(dialog)
    })
    await flush()
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(dialog)

    await click(buttonWith('退出跟做'))
    expect(document.querySelector('[data-guide-overlay]')).toBeNull()
    expect(document.querySelector('[data-guide-entry]')).toBeNull()

    await act(async () => {
      unregister?.()
    })
    await flush()
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()
    dialog.remove()
  })
})
