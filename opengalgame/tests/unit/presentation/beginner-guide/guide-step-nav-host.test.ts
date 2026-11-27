// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BeginnerGuideHost } from '@presentation/features/beginner-guide/BeginnerGuideHost'
import { GUIDE_PREFERENCES_KEY } from '@presentation/features/beginner-guide/guidePreferences'
import type {
  CardCreatedFact,
  ConfigTestFailedFact,
  GuideContextSnapshot,
  GuideFact,
  GuideObservationSource
} from '@presentation/features/beginner-guide/guideObservation'
import { TEST_SCOPE, fact } from './guideFacts'

vi.mock('@presentation/features/beginner-guide/useGuideMotion', () => ({
  useGuideOverlayMotion: () => undefined,
  useGuideConnectionMotion: () => undefined
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('matchMedia', () => ({ matches: true }))
HTMLDialogElement.prototype.showModal = function () {
  this.open = true
}
HTMLDialogElement.prototype.close = function () {
  this.open = false
}
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
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

  emit(nextFact: GuideFact): void {
    for (const listener of [...this.factListeners]) listener(nextFact)
  }

  setSnapshot(next: GuideContextSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.contextListeners]) listener(next)
  }
}

const mounted: Array<() => Promise<void>> = []

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem(
    GUIDE_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      invitationHandled: true,
      tutorialModeActive: true,
      lastStepId: null,
      lastBeatId: null
    })
  )
})

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.()
  window.localStorage.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve()
  })
}

async function mountHost(source: FakeGuideSource, restoreEntryRequest = 0): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(BeginnerGuideHost, {
        page: 'workbench',
        restoreEntryRequest,
        observationSource: source,
        importMedia: async () => 'unavailable' as const
      })
    )
  })
  await flush()
  mounted.push(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
}

async function emit(source: FakeGuideSource, nextFact: GuideFact): Promise<void> {
  await act(async () => {
    source.emit(nextFact)
  })
  await flush()
}

async function clickNav(direction: 'previous' | 'next'): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-guide-nav="${direction}"]`)
  if (!button) throw new Error(`没有找到导航按钮：${direction}`)
  await act(async () => {
    button.click()
  })
  await flush()
}

function navButton(direction: 'previous' | 'next'): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-guide-nav="${direction}"]`)
  if (!button) throw new Error(`没有找到导航按钮：${direction}`)
  return button
}

async function openGuideAt(stepId: string, snapshot = WORKBENCH): Promise<FakeGuideSource> {
  window.localStorage.setItem(
    GUIDE_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      invitationHandled: true,
      lastStepId: stepId,
      lastBeatId: null
    })
  )
  const source = new FakeGuideSource(snapshot)
  await mountHost(source, 0)
  const entry = document.querySelector<HTMLButtonElement>('[data-guide-entry]')
  if (!entry) throw new Error('没有找到教程入口')
  await act(async () => {
    entry.click()
  })
  await flush()
  const start = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('开始跟做')
  )
  if (!(start instanceof HTMLButtonElement)) throw new Error('没有找到开始跟做按钮')
  await act(async () => {
    start.click()
  })
  await flush()
  return source
}

describe('步骤签上的上一步与下一步', () => {
  it('未完成步骤也能自由前进后退，按钮下方没有可见的完成态小字', async () => {
    const source = new FakeGuideSource(WORKBENCH)
    await mountHost(source)
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()

    expect(navButton('previous').getAttribute('aria-disabled')).toBe('true')
    expect(navButton('next').getAttribute('aria-disabled')).toBeNull()
    expect(navButton('next').getAttribute('aria-label')).toContain('前往第 2 步「创建工程项目」')
    expect(document.body.textContent).not.toContain('先完成当前这一步')
    expect(document.body.textContent).not.toContain('还没有完成的步骤可以回看')

    await clickNav('next')
    expect(document.body.textContent).toContain('第 2 / 8 步')
    expect(document.body.textContent).toContain('给这场戏留一个位置')

    await clickNav('next')
    expect(document.body.textContent).toContain('第 3 / 8 步')
    expect(document.body.textContent).toContain('选一段能从头读到尾的戏')

    await clickNav('previous')
    expect(document.body.textContent).toContain('第 2 / 8 步')

    await clickNav('previous')
    expect(document.body.textContent).toContain('第 1 / 8 步')
    expect(document.body.textContent).toContain('先接通一个模型')
    expect(navButton('previous').getAttribute('aria-disabled')).toBe('true')
  })

  it('配置失败也保留自由导航，不显示完成态先决条件', async () => {
    const source = new FakeGuideSource(WORKBENCH)
    await mountHost(source)
    await emit(
      source,
      fact<ConfigTestFailedFact>({
        kind: 'configTestFailed',
        configFingerprint: 'fp-1',
        outcome: 'failed'
      })
    )
    expect(document.body.textContent).toContain('连接还没测通')
    expect(navButton('next').getAttribute('aria-disabled')).toBeNull()
    expect(document.body.textContent).not.toContain('先完成当前这一步')
    expect(document.body.textContent).not.toContain('已完成')
    expect(document.body.textContent).not.toContain('未完成')
  })

  it('第 4 步第 1 拍上一步回到第 3 步，下一步自由到第 2 拍', async () => {
    const source = await openGuideAt('arrange-scene')
    expect(document.body.textContent).toContain('本步第 1 / 6 拍')
    expect(navButton('previous').getAttribute('aria-disabled')).toBeNull()
    expect(navButton('next').getAttribute('aria-disabled')).toBeNull()
    expect(document.body.textContent).not.toContain('先完成当前这一步')

    await clickNav('previous')
    expect(document.body.textContent).toContain('第 3 / 8 步')
    expect(document.body.textContent).toContain('选一段能从头读到尾的戏')

    await clickNav('next')
    expect(document.body.textContent).toContain('第 4 / 8 步')
    expect(document.body.textContent).toContain('本步第 1 / 6 拍')

    await clickNav('next')
    expect(document.body.textContent).toContain('本步第 2 / 6 拍')
    expect(document.body.textContent).toContain('先让玩家听见')
    expect(navButton('next').getAttribute('aria-disabled')).toBeNull()

    await clickNav('previous')
    expect(document.body.textContent).toContain('本步第 1 / 6 拍')
    expect(document.body.textContent).toContain('添加场景背景图')
  })

  it('徽标显示实际卡片名并随重命名同步，缺名时回退背景图', async () => {
    const source = await openGuideAt('arrange-scene', {
      ...WORKBENCH,
      cardTitles: { 'image-1': 'dormitory.png' }
    })
    await emit(
      source,
      fact<CardCreatedFact>({ kind: 'cardCreated', cardId: 'image-1', cardKind: 'image' })
    )

    expect(document.body.textContent).toContain('当前：dormitory.png')
    expect(document.body.textContent).toContain('本拍已就位')
    expect(document.body.textContent).toContain('dormitory.png')
    expect(document.body.textContent).not.toContain('当前：开场图')

    await act(async () => {
      source.setSnapshot({
        ...WORKBENCH,
        cardTitles: { 'image-1': 'dormitory-renamed.png' }
      })
    })
    await flush()
    expect(document.body.textContent).toContain('当前：dormitory-renamed.png')
    expect(document.body.textContent).not.toContain('dormitory.png')

    await act(async () => {
      source.setSnapshot({ ...WORKBENCH, cardTitles: {} })
    })
    await flush()
    expect(document.body.textContent).toContain('当前：背景图')
    expect(document.body.textContent).not.toContain('dormitory-renamed.png')
    expect(document.body.textContent).not.toContain('开场图')
  })

  it('最后一步下一步禁用时不显示可见原因', async () => {
    await openGuideAt('export-build')
    expect(navButton('next').getAttribute('aria-disabled')).toBe('true')
    expect(navButton('next').getAttribute('aria-label')).toContain('已经是最后一步')
    expect(document.body.textContent).not.toContain('已经到最后一步了')
    expect(document.body.textContent).not.toContain('先完成当前这一步')
    expect(navButton('previous').getAttribute('aria-disabled')).toBeNull()
  })
})
