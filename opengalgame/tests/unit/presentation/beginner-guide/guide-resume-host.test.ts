// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BeginnerGuideHost } from '@presentation/features/beginner-guide/BeginnerGuideHost'
import { registerPageModal } from '@presentation/components/dialogElement'
import type {
  CandidateAcceptedFact,
  CandidateOpenedFact,
  CandidateReadyFact,
  CandidateReturnedFact,
  CanvasSavedFact,
  GenerationFailedFact,
  GenerationStartedFact,
  GuideContextSnapshot,
  GuideFact,
  GuideObservationSource,
  InputSummaryOpenedFact
} from '@presentation/features/beginner-guide/guideObservation'
import { GUIDE_PREFERENCES_KEY } from '@presentation/features/beginner-guide/guidePreferences'
import { setGuideTopLayerHost } from '@presentation/features/beginner-guide/guideTopLayer'
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

const WORKBENCH_A: GuideContextSnapshot = {
  page: 'workbench',
  projectId: TEST_SCOPE.projectId,
  sceneId: TEST_SCOPE.sceneId,
  canvasId: TEST_SCOPE.canvasId,
  documentLayerCardId: null,
  saveState: 'saved',
  arrangementStatus: 'ready',
  previewOpen: false,
  generationDrawerOpen: false,
  mediaAvailability: { image: true, audio: true, video: false }
}

const PROJECT_PAGE: GuideContextSnapshot = {
  ...WORKBENCH_A,
  page: 'project-list',
  projectId: null,
  sceneId: null,
  canvasId: null,
  saveState: 'unknown',
  arrangementStatus: 'unknown'
}

const WORKBENCH_B: GuideContextSnapshot = {
  ...WORKBENCH_A,
  projectId: 'project-2',
  sceneId: 'scene-2',
  canvasId: 'canvas-2'
}

const WORKBENCH_A_SCENE_2: GuideContextSnapshot = {
  ...WORKBENCH_A,
  sceneId: 'scene-2',
  canvasId: 'canvas-2'
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

type HostPage = 'home' | 'projects' | 'workbench'

const mounted: Array<() => Promise<void>> = []

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem(
    GUIDE_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      invitationHandled: true,
      lastStepId: 'save-and-generate'
    })
  )
})

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.()
  setGuideTopLayerHost(null)
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
  page: HostPage = 'workbench',
  restartRequest = 1
): Promise<{ render: (page: HostPage) => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (nextPage: HostPage = page): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(BeginnerGuideHost, {
          page: nextPage,
          restartRequest,
          observationSource: source,
          importMedia: async () => 'unavailable' as const
        })
      )
    })
    await flush()
  }
  mounted.push(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
  await render(page)
  return { render }
}

function buttonWith(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`没有找到按钮：${text}`)
  return button
}

async function clickButton(text: string): Promise<void> {
  await act(async () => {
    buttonWith(text).click()
  })
  await flush()
}

async function emit(source: FakeGuideSource, nextFact: GuideFact): Promise<void> {
  await act(async () => {
    source.emit(nextFact)
  })
  await flush()
}

async function setSnapshot(source: FakeGuideSource, next: GuideContextSnapshot): Promise<void> {
  await act(async () => {
    source.setSnapshot(next)
  })
  await flush()
}

async function enterStepFiveWaiting(source: FakeGuideSource): Promise<void> {
  expect(document.querySelector('[data-guide-entry]')).toBeNull()
  await clickButton('步骤目录')
  await clickButton('检查输入并生成')

  await emit(source, fact<CanvasSavedFact>({ kind: 'canvasSaved', reason: 'manual' }))
  await emit(source, fact<InputSummaryOpenedFact>({ kind: 'inputSummaryOpened' }))
  await emit(
    source,
    fact<GenerationStartedFact>({
      kind: 'generationStarted',
      operationId: 'operation-1'
    })
  )
  expect(document.body.textContent).toContain('等候这一版候选')
}

async function enterCandidateDecision(source: FakeGuideSource): Promise<void> {
  await enterStepFiveWaiting(source)
  await emit(
    source,
    fact<CandidateReadyFact>({
      kind: 'candidateReady',
      candidateSnapshotId: 'candidate-1',
      operationId: 'operation-1'
    })
  )
  expect(document.body.textContent).toContain('从头玩一遍')
  await emit(
    source,
    fact<CandidateOpenedFact>({
      kind: 'candidateOpened',
      candidateSnapshotId: 'candidate-1'
    })
  )
  await emit(source, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
  expect(document.body.textContent).toContain('和你想的一样吗？')
}

async function enterCandidateReady(source: FakeGuideSource): Promise<void> {
  await enterStepFiveWaiting(source)
  await emit(
    source,
    fact<CandidateReadyFact>({
      kind: 'candidateReady',
      candidateSnapshotId: 'candidate-1',
      operationId: 'operation-1'
    })
  )
}

describe('教程入口与页面模态', () => {
  it('页面模态打开时隐藏独立教程入口，关闭后恢复', async () => {
    window.localStorage.setItem(
      GUIDE_PREFERENCES_KEY,
      JSON.stringify({ version: 1, invitationHandled: true, lastStepId: null })
    )
    const source = new FakeGuideSource(WORKBENCH_A)
    await mountHost(source, 'workbench', 0)
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()

    const dialog = document.createElement('dialog')
    document.body.appendChild(dialog)
    let unregister: (() => void) | null = null
    await act(async () => {
      unregister = registerPageModal(dialog)
    })
    await flush()
    expect(document.querySelector('[data-guide-entry]')).toBeNull()

    await act(async () => {
      unregister?.()
    })
    await flush()
    expect(document.querySelector('[data-guide-entry]')).not.toBeNull()
    dialog.remove()
  })
})

describe('教程在项目页/场景切换中的恢复', () => {
  it('项目页点在此继续不丢第 5 步队列，也不替用户切页', async () => {
    const source = new FakeGuideSource(WORKBENCH_A)
    await mountHost(source)
    await enterStepFiveWaiting(source)

    await setSnapshot(source, PROJECT_PAGE)
    expect(document.body.textContent).toContain('跟做已停在这里')
    expect(buttonWith('在此继续')).toBeTruthy()
    expect(buttonWith('退出跟做')).toBeTruthy()

    await emit(
      source,
      fact<GenerationFailedFact>({
        kind: 'generationFailed',
        operationId: 'operation-1'
      })
    )
    expect(document.body.textContent).toContain('跟做已停在这里')

    await clickButton('在此继续')
    expect(source.readCurrent().page).toBe('project-list')
    expect(document.body.textContent).not.toContain('跟做已停在这里')
    expect(document.body.textContent).toContain('这一版没生成出来')
  }, 20_000)

  it('项目页点在此继续后回同工程，补齐暂停期间到达的候选', async () => {
    const source = new FakeGuideSource(WORKBENCH_A)
    const host = await mountHost(source)
    await enterStepFiveWaiting(source)

    await setSnapshot(source, PROJECT_PAGE)
    await host.render('projects')
    await flush()
    expect(document.body.textContent).toContain('跟做已停在这里')

    await emit(
      source,
      fact<CandidateReadyFact>({
        kind: 'candidateReady',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect(document.body.textContent).toContain('跟做已停在这里')

    await clickButton('在此继续')
    expect(document.body.textContent).toContain('从头玩一遍')
    expect(document.body.textContent).not.toContain('跟做已停在这里')

    await setSnapshot(source, WORKBENCH_A)
    await host.render('workbench')
    await flush()
    expect(document.body.textContent).toContain('从头玩一遍')

    await emit(
      source,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    await emit(source, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    expect(document.body.textContent).toContain('和你想的一样吗？')
  }, 20_000)

  it('真正换到另一个工程后，在此继续按新工程重排本步', async () => {
    const source = new FakeGuideSource(WORKBENCH_A)
    const host = await mountHost(source)
    await enterStepFiveWaiting(source)

    await setSnapshot(source, WORKBENCH_B)
    await host.render('workbench')
    await flush()
    expect(document.body.textContent).toContain('跟做已停在这里')

    await clickButton('在此继续')
    expect(source.readCurrent().projectId).toBe('project-2')
    expect(document.body.textContent).not.toContain('跟做已停在这里')
    expect(document.body.textContent).not.toContain('等候这一版候选')
    expect(document.body.textContent).toContain('把这版画布存下来')
  }, 20_000)

  it('同一工程真正换场景后，在此继续仍重排本步', async () => {
    const source = new FakeGuideSource(WORKBENCH_A)
    const host = await mountHost(source)
    await enterStepFiveWaiting(source)

    await setSnapshot(source, WORKBENCH_A_SCENE_2)
    await host.render('workbench')
    await flush()
    expect(document.body.textContent).toContain('跟做已停在这里')

    await clickButton('在此继续')
    expect(source.readCurrent().sceneId).toBe('scene-2')
    expect(document.body.textContent).not.toContain('等候这一版候选')
    expect(document.body.textContent).toContain('把这版画布存下来')
  }, 20_000)

  it('生成抽屉已开时候选就绪，教程保持展开且不把展示当试玩', async () => {
    const slot = document.createElement('div')
    slot.setAttribute('data-guide-top-layer-host', '')
    document.body.appendChild(slot)
    setGuideTopLayerHost(slot)
    const source = new FakeGuideSource({ ...WORKBENCH_A, generationDrawerOpen: true })
    await mountHost(source)
    await enterCandidateReady(source)
    expect(source.readCurrent().generationDrawerOpen).toBe(true)
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.querySelector('[data-guide-overlay="collapsed"]')).toBeNull()
    expect(document.body.textContent).toContain('收起，去试玩')
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(slot)

    await emit(
      source,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.body.textContent).toContain('正在试玩候选')
    expect(document.body.textContent).not.toContain('在试玩预览里改一句')

    await emit(source, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.body.textContent).toContain('和你想的一样吗？')
    expect(document.body.textContent).not.toContain('在试玩预览里改一句')
  }, 20_000)

  it('候选就绪后打开生成抽屉，教程移入抽屉槽位并保持展开，返回仍停在第 6 步', async () => {
    const source = new FakeGuideSource(WORKBENCH_A)
    await mountHost(source)
    await enterCandidateReady(source)
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.body.textContent).toContain('收起，去试玩')
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(document.body)

    const slot = document.createElement('div')
    slot.setAttribute('data-guide-top-layer-host', '')
    document.body.appendChild(slot)
    await act(async () => {
      setGuideTopLayerHost(slot)
    })

    await setSnapshot(source, { ...WORKBENCH_A, generationDrawerOpen: true })
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.querySelector('[data-guide-overlay="collapsed"]')).toBeNull()
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(slot)
    expect(document.body.textContent).toContain('收起，去试玩')

    await setSnapshot(source, WORKBENCH_A)
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.querySelector('[data-guide-portal]')?.parentElement).toBe(document.body)

    await emit(
      source,
      fact<CandidateOpenedFact>({
        kind: 'candidateOpened',
        candidateSnapshotId: 'candidate-1'
      })
    )
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.body.textContent).toContain('正在试玩候选')
    await emit(source, fact<CandidateReturnedFact>({ kind: 'candidateReturned' }))
    expect(document.querySelector('[data-guide-overlay="expanded"]')).not.toBeNull()
    expect(document.body.textContent).toContain('和你想的一样吗？')
    expect(document.body.textContent).not.toContain('在试玩预览里改一句')
  }, 20_000)

  it('第 6 步在项目页暂停时，接受在继续前到达也不丢', async () => {
    const source = new FakeGuideSource(WORKBENCH_A)
    const host = await mountHost(source)
    await enterCandidateDecision(source)

    await setSnapshot(source, PROJECT_PAGE)
    await host.render('projects')
    await flush()
    expect(document.body.textContent).toContain('跟做已停在这里')
    expect(buttonWith('在此继续')).toBeTruthy()
    expect(buttonWith('退出跟做')).toBeTruthy()

    await emit(
      source,
      fact<CandidateAcceptedFact>({
        kind: 'candidateAccepted',
        candidateSnapshotId: 'candidate-1',
        operationId: 'operation-1'
      })
    )
    expect(document.body.textContent).toContain('跟做已停在这里')

    await clickButton('在此继续')
    expect(source.readCurrent().page).toBe('project-list')
    expect(document.body.textContent).not.toContain('跟做已停在这里')
    expect(document.body.textContent).not.toContain('从头玩一遍')
    expect(document.body.textContent).toContain('在试玩预览里改一句')
  }, 20_000)
})
