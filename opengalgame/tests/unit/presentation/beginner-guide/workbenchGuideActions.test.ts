import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectFileAssetKind,
  ProjectInputContentKind,
  ProjectInputSourceSummaryVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import { COMMIT_UNCLEAR_CODE } from '@presentation/feedback/projectFilesFeedback'
import {
  createCreatorActionObservation,
  type CreatorActionObservation,
  type CreatorNavigation,
  type CreatorNavigationSnapshot
} from '@presentation/app/observeCreatorActions'
import {
  advanceGuide,
  createGuideState,
  type GuideSessionState
} from '@presentation/features/beginner-guide/advanceGuide'
import {
  guideMediaImportActionOf,
  guideMediaImportOutcomeOf
} from '@presentation/features/beginner-guide/guideMedia'
import type { GuideFact } from '@presentation/features/beginner-guide/guideObservation'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'
import {
  chooseAndImport,
  placeSourceOnCanvas
} from '@presentation/features/input-catalog/catalogWrites'
import type { CatalogImportOutcome } from '@presentation/features/input-catalog/inputCatalog.types'
import {
  createWorkbenchCommands,
  setActiveWorkbenchCommands,
  type WorkbenchCommands
} from '@presentation/features/workbench-session/workbenchCommands'
import type {
  ImportedSourceAction,
  ImportedSourcesHandler,
  WorkbenchActionObservers
} from '@presentation/features/workbench-session/workbenchActionObservers'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { AppPage } from '@presentation/stores/navigation.store'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

const SCOPE = { projectId: 'p-01', sceneId: 'scene-1', canvasId: 'canvas-1' }

class FakeNavigation implements CreatorNavigation {
  private current: CreatorNavigationSnapshot = { page: 'workbench', projectId: 'p-01' }
  private readonly listeners = new Set<(snapshot: CreatorNavigationSnapshot) => void>()

  read(): CreatorNavigationSnapshot {
    return this.current
  }

  subscribe(listener: (snapshot: CreatorNavigationSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  visit(page: AppPage, projectId: string | null = null): void {
    this.current = { page, projectId }
    for (const listener of [...this.listeners]) listener(this.current)
  }

  openWorkbench(projectId: string): void {
    this.visit('workbench', projectId)
  }
}

function arrangement(): SceneCanvasArrangementVO {
  return {
    projectId: 'p-01',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'doc-1',
        title: '角色',
        summary: '',
        layout: { x: 0, y: 0, width: 300, height: 224 }
      },
      {
        kind: 'image',
        cardId: 'img',
        sourceId: 'img-1',
        role: 'background',
        title: '屋顶',
        summary: '',
        layout: { x: 332, y: 0, width: 320, height: 208 }
      }
    ],
    relations: []
  }
}

function startWorkbench(projectId = 'p-01'): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId,
    projectName: '未寄出的第二封信',
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
  useWorkbenchSessionStore.getState().setArrangement({
    ...arrangement(),
    projectId
  })
}

function setup(options?: { projectId?: string; observers?: WorkbenchActionObservers }): {
  navigation: FakeNavigation
  observation: CreatorActionObservation
  facts: GuideFact[]
  unsubscribe: () => void
} {
  startWorkbench(options?.projectId ?? 'p-01')
  const navigation = new FakeNavigation()
  const observation = createCreatorActionObservation({
    navigation,
    now: () => new Date('2026-11-22T10:00:00.000Z')
  })
  const facts: GuideFact[] = []
  const unsubscribe = observation.source.subscribe((fact) => facts.push(fact))
  return { navigation, observation, facts, unsubscribe }
}

function applyAll(state: GuideSessionState, facts: readonly GuideFact[]): GuideSessionState {
  return facts.reduce((current, fact) => advanceGuide(current, { type: 'fact', fact }).state, state)
}

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

const candidateExtension: Record<ProjectInputContentKind, string> = {
  text: 'md',
  image: 'png',
  audio: 'wav',
  video: 'mp4'
}

function summary(
  sourceId: string,
  contentKind: ProjectInputContentKind,
  name = `${sourceId}.${candidateExtension[contentKind]}`
): ProjectInputSourceSummaryVO {
  if (contentKind === 'text') {
    return {
      sourceId,
      name,
      readable: true,
      parentFolderId: null,
      contentKind: 'text',
      textKind: 'document'
    }
  }
  return {
    sourceId,
    name,
    readable: true,
    parentFolderId: null,
    contentKind
  }
}

async function importWith(
  client: ProjectFilesClient,
  options?: {
    mediaKinds?: readonly ProjectFileAssetKind[]
    onImported?: ImportedSourcesHandler
  }
): Promise<CatalogImportOutcome> {
  startWorkbench()
  return chooseAndImport(
    client,
    new QueryClient(),
    'p-01',
    null,
    false,
    () => undefined,
    options?.onImported,
    options?.mediaKinds ? { mediaKinds: options.mediaKinds } : undefined
  )
}

afterEach(() => {
  setActiveWorkbenchCommands(null)
  useWorkbenchSessionStore.getState().reset()
})

describe('工作台动作事实：导入 → 文档卡 → 阅读', () => {
  it('按导入、建卡、阅读的顺序推进，并在最后一步进入步骤 4', () => {
    const { observation, facts } = setup()
    let state = createGuideState({ stepId: GUIDE_STEP_ID.importScript })

    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(state.milestoneIndex).toBe(1)

    observation.workbench.onCardCreated({
      scope: SCOPE,
      cardId: 'card-doc',
      cardKind: 'document'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(state.milestoneIndex).toBe(2)

    observation.workbench.onDocumentOpened({ scope: SCOPE, cardId: 'card-doc' })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(state.milestoneIndex).toBe(2)
    expect(state.prompt.title).toBe('查看或编辑正文')

    observation.workbench.onDocumentClosed({ scope: SCOPE, cardId: 'card-doc' })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(state.milestoneIndex).toBe(0)
  })

  it('只有文档导入发布来源事实，素材导入不发布逐媒体 ID', () => {
    const { observation, facts } = setup()
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'img-1',
      contentKind: 'image'
    })
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'aud-1',
      contentKind: 'audio'
    })
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'vid-1',
      contentKind: 'video'
    })
    expect(facts).toHaveLength(0)

    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      kind: 'sourceImported',
      sourceKind: 'document',
      sourceId: 'src-1'
    })
  })

  it('素材导入不发布事实，也不推进第 4 步，必须有已确认卡片', () => {
    const { observation, facts } = setup()
    let state = createGuideState({ stepId: GUIDE_STEP_ID.arrangeScene })
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-aud',
      contentKind: 'audio'
    })
    expect(facts).toHaveLength(0)
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(state.milestoneIndex).toBe(0)
  })

  it('项目不一致或页面不在工作台时不产生事实', () => {
    const { observation, navigation, facts } = setup()
    observation.workbench.onSourceImported({
      projectId: 'p-02',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    navigation.visit('projects')
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    expect(facts).toHaveLength(0)
  })

  it('没有监听者时不上报事实', () => {
    const { observation, facts, unsubscribe } = setup()
    unsubscribe()
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    expect(facts).toHaveLength(0)
  })

  it('重复导入/建卡通知不会跳过文档阅读', () => {
    const { observation, facts } = setup()
    let state = createGuideState({ stepId: GUIDE_STEP_ID.importScript })
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    observation.workbench.onSourceImported({
      projectId: 'p-01',
      sourceId: 'src-1',
      contentKind: 'text'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(1)

    observation.workbench.onCardCreated({
      scope: SCOPE,
      cardId: 'card-doc',
      cardKind: 'document'
    })
    observation.workbench.onCardCreated({
      scope: SCOPE,
      cardId: 'card-doc',
      cardKind: 'document'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.importScript)
    expect(state.milestoneIndex).toBe(2)
  })
})

describe('工作台动作事实：素材卡 → 用途 → 连线 → 命名', () => {
  it('第一拍只由开场图自己的用途与命名结束，反向端点也接受', () => {
    const { observation, facts } = setup()
    let state = createGuideState({ stepId: GUIDE_STEP_ID.arrangeScene })

    // 直接跳入第 4 步时，由用户明确点选剧本卡，不扫描同类文档卡。
    observation.workbench.onCardSelected({
      scope: SCOPE,
      cardId: 'card-doc',
      cardKind: 'document'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.arrangeCards).toEqual({ script: 'card-doc' })
    expect(state.milestoneIndex).toBe(0)

    observation.workbench.onCardCreated({
      scope: SCOPE,
      cardId: 'card-audio',
      cardKind: 'audio'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(0)

    observation.workbench.onCardCreated({
      scope: SCOPE,
      cardId: 'card-image',
      cardKind: 'image'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(1)
    expect(state.arrangeCards).toEqual({ script: 'card-doc', opening: 'card-image' })

    observation.workbench.onCardEdited({
      scope: SCOPE,
      cardId: 'card-image-other',
      cardKind: 'image'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(1)

    observation.workbench.onCardEdited({
      scope: SCOPE,
      cardId: 'card-image',
      cardKind: 'image'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(2)

    // 命名先到、端点错误都不算；反向拖出的无向连线接受。
    observation.workbench.onRelationNamed({
      scope: SCOPE,
      relationId: 'rel-1',
      fromCardId: 'card-doc',
      fromCardKind: 'document',
      toCardId: 'card-image',
      toCardKind: 'image'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(2)

    observation.workbench.onRelationCreated({
      scope: SCOPE,
      relationId: 'rel-wrong',
      fromCardId: 'card-image',
      fromCardKind: 'image',
      toCardId: 'card-audio',
      toCardKind: 'audio'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(2)

    observation.workbench.onRelationCreated({
      scope: SCOPE,
      relationId: 'rel-1',
      fromCardId: 'card-image',
      fromCardKind: 'image',
      toCardId: 'card-doc',
      toCardKind: 'document'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(3)
    expect(facts).toHaveLength(0)

    observation.workbench.onRelationNamed({
      scope: SCOPE,
      relationId: 'rel-1',
      fromCardId: 'card-image',
      fromCardKind: 'image',
      toCardId: 'card-doc',
      toCardKind: 'document'
    })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.arrangeScene)
    expect(state.milestoneIndex).toBe(4)
    expect(state.prompt.confirmLabel).toBeUndefined()
    expect(state.prompt.text).toContain('短声音')

    const early = advanceGuide(state, { type: 'confirm-step' }).state
    expect(early).toBe(state)
  })

  it('编辑其他素材种类的卡片不产生事实', () => {
    const { observation, facts } = setup()
    observation.workbench.onCardEdited({
      scope: SCOPE,
      cardId: 'card-doc',
      cardKind: 'document'
    })
    expect(facts).toHaveLength(0)
  })

  it('删卡和删线只上报已跟踪类型与当前工程的旧对象身份', () => {
    const { observation, facts } = setup()
    observation.workbench.onCardDeleted({
      scope: SCOPE,
      cardId: 'card-image',
      cardKind: 'image'
    })
    expect(facts[0]).toMatchObject({
      kind: 'cardDeleted',
      cardId: 'card-image',
      cardKind: 'image'
    })
    facts.splice(0)

    observation.workbench.onCardDeleted({
      scope: SCOPE,
      cardId: 'card-animation',
      cardKind: 'animation'
    })
    observation.workbench.onCardDeleted({
      scope: { ...SCOPE, projectId: 'p-02' },
      cardId: 'card-other-project',
      cardKind: 'image'
    })
    expect(facts).toHaveLength(0)

    observation.workbench.onRelationDeleted({
      scope: SCOPE,
      relationId: 'rel-1',
      fromCardId: 'card-doc',
      fromCardKind: 'document',
      toCardId: 'card-image',
      toCardKind: 'image'
    })
    expect(facts[0]).toMatchObject({
      kind: 'relationDeleted',
      relationId: 'rel-1',
      fromCardId: 'card-doc',
      toCardId: 'card-image',
      fromCardKind: 'document',
      toCardKind: 'image'
    })
    facts.splice(0)

    observation.workbench.onRelationDeleted({
      scope: { ...SCOPE, sceneId: 'scene-2' },
      relationId: 'rel-2',
      fromCardId: 'card-doc',
      fromCardKind: 'document',
      toCardId: 'card-image',
      toCardKind: 'image'
    })
    expect(facts).toHaveLength(0)
  })
})

describe('工作台动作事实：手动保存与输入摘要', () => {
  it('手动保存后打开摘要才进入生成步骤', () => {
    const { observation, facts } = setup()
    let state = createGuideState({ stepId: GUIDE_STEP_ID.saveAndGenerate })

    observation.workbench.onCanvasSaved({ scope: SCOPE })
    expect(facts[0]).toMatchObject({ kind: 'canvasSaved', reason: 'manual' })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(1)
    expect(facts).toHaveLength(0)

    observation.workbench.onCanvasSaved({ scope: SCOPE })
    state = applyAll(state, facts.splice(0))
    expect(state.milestoneIndex).toBe(1)

    observation.workbench.onInputSummaryOpened({ scope: SCOPE })
    state = applyAll(state, facts.splice(0))
    expect(state.stepId).toBe(GUIDE_STEP_ID.saveAndGenerate)
    expect(state.milestoneIndex).toBe(2)
  })

  it('旧工程/旧场景的迟到事实被丢弃', () => {
    const { observation, facts } = setup()
    observation.workbench.onCardCreated({
      scope: { projectId: 'p-02', sceneId: 'scene-2', canvasId: 'canvas-2' },
      cardId: 'card-image',
      cardKind: 'image'
    })
    expect(facts).toHaveLength(0)
  })
})

describe('工作台命令：只在成功点上报', () => {
  interface FakeCalls {
    editCard: number
    deleteCard: number
    connectCards: number
    disconnectCards: number
    editRelationName: number
    save: number
    createSourceCard: number
    createPromptCard: number
    editPromptBody: number
    promptBodies: string[]
  }

  function createCommands(options?: {
    editCardCode?: number
    editCardGate?: Promise<void>
    promptBodyCode?: number
    promptBodyGate?: Promise<void>
  }): {
    commands: WorkbenchCommands
    calls: FakeCalls
    observers: WorkbenchActionObservers
    facts: GuideFact[]
  } {
    startWorkbench()
    const calls: FakeCalls = {
      editCard: 0,
      deleteCard: 0,
      connectCards: 0,
      disconnectCards: 0,
      editRelationName: 0,
      save: 0,
      createSourceCard: 0,
      createPromptCard: 0,
      editPromptBody: 0,
      promptBodies: []
    }
    let nextCardId = 0
    const client = {
      createSourceCard: async (request: {
        arrangement: SceneCanvasArrangementVO
        sourceId: string
        layout: { x: number; y: number; width: number; height: number }
      }) => {
        calls.createSourceCard += 1
        nextCardId += 1
        const source = useWorkbenchSessionStore
          .getState()
          .sources.find((item) => item.sourceId === request.sourceId)
        const contentKind = source?.contentKind ?? 'image'
        const kind = contentKind === 'text' ? 'document' : contentKind
        const next = structuredClone(request.arrangement)
        const base = {
          cardId: `new-card-${nextCardId}`,
          title: '',
          summary: '',
          layout: request.layout
        }
        next.cards = [
          ...next.cards,
          kind === 'document'
            ? { ...base, kind: 'document', sourceId: request.sourceId }
            : kind === 'image'
              ? { ...base, kind: 'image', sourceId: request.sourceId, role: 'background' }
              : kind === 'audio'
                ? { ...base, kind: 'audio', sourceId: request.sourceId, role: 'music' }
                : { ...base, kind: 'video', sourceId: request.sourceId }
        ]
        return ok(next)
      },
      createPromptCard: async (request: {
        arrangement: SceneCanvasArrangementVO
        layout: { x: number; y: number; width: number; height: number }
      }) => {
        calls.createPromptCard += 1
        nextCardId += 1
        const next = structuredClone(request.arrangement)
        next.cards = [
          ...next.cards,
          {
            kind: 'prompt',
            cardId: `new-prompt-${nextCardId}`,
            body: '',
            references: [],
            layout: request.layout
          }
        ]
        return ok(next)
      },
      editPromptBody: async (request: {
        arrangement: SceneCanvasArrangementVO
        cardId: string
        body: string
      }) => {
        calls.editPromptBody += 1
        calls.promptBodies.push(request.body)
        if (options?.promptBodyGate) await options.promptBodyGate
        if (options?.promptBodyCode) {
          return { code: options.promptBodyCode, msg: '正文写入失败', data: null }
        }
        const next = structuredClone(request.arrangement)
        next.cards = next.cards.map((card) =>
          card.cardId === request.cardId && card.kind === 'prompt'
            ? { ...card, body: request.body }
            : card
        )
        return ok(next)
      },
      editCard: async (request: {
        arrangement: SceneCanvasArrangementVO
        cardId: string
        title?: string
        summary?: string
      }) => {
        calls.editCard += 1
        if (options?.editCardGate) await options.editCardGate
        if (options?.editCardCode) {
          return { code: options.editCardCode, msg: '写入失败', data: null }
        }
        const next = structuredClone(request.arrangement)
        next.cards = next.cards.map((card) => {
          if (card.cardId !== request.cardId) return card
          if (card.kind === 'prompt' || card.kind === 'animation' || card.kind === 'effect') {
            return card
          }
          return {
            ...card,
            title: request.title ?? card.title,
            summary: request.summary ?? card.summary
          }
        })
        return ok(next)
      },
      deleteCard: async (request: { arrangement: SceneCanvasArrangementVO; cardId: string }) => {
        calls.deleteCard += 1
        const next = structuredClone(request.arrangement)
        next.cards = next.cards.filter((card) => card.cardId !== request.cardId)
        next.relations = next.relations.filter(
          (relation) =>
            relation.fromCardId !== request.cardId && relation.toCardId !== request.cardId
        )
        return ok(next)
      },
      connectCards: async (request: {
        arrangement: SceneCanvasArrangementVO
        fromCardId: string
        toCardId: string
      }) => {
        calls.connectCards += 1
        const next = structuredClone(request.arrangement)
        next.relations = [
          ...next.relations,
          {
            relationId: 'rel-new',
            fromCardId: request.fromCardId,
            toCardId: request.toCardId,
            specificName: '',
            recordCardId: null
          }
        ]
        return ok(next)
      },
      disconnectCards: async (request: {
        arrangement: SceneCanvasArrangementVO
        relationId: string
      }) => {
        calls.disconnectCards += 1
        const next = structuredClone(request.arrangement)
        next.relations = next.relations.filter(
          (relation) => relation.relationId !== request.relationId
        )
        return ok(next)
      },
      editRelationName: async (request: {
        arrangement: SceneCanvasArrangementVO
        relationId: string
        specificName: string
      }) => {
        calls.editRelationName += 1
        const next = structuredClone(request.arrangement)
        next.relations = next.relations.map((relation) =>
          relation.relationId === request.relationId
            ? { ...relation, specificName: request.specificName }
            : relation
        )
        return ok(next)
      },
      saveSceneCanvasArrangement: async (request: { arrangement: SceneCanvasArrangementVO }) => {
        calls.save += 1
        return ok(structuredClone(request.arrangement))
      }
    } as unknown as SceneCanvasClient
    const facts: GuideFact[] = []
    const observers: WorkbenchActionObservers = {
      onCardCreated: (event) => facts.push(factOf('cardCreated', event)),
      onCardSelected: (event) => facts.push(factOf('cardSelected', event)),
      onCardDeleted: (event) => facts.push(factOf('cardDeleted', event)),
      onDocumentOpened: (event) => facts.push(factOf('documentOpened', event)),
      onDocumentClosed: (event) => facts.push(factOf('documentClosed', event)),
      onCardEdited: (event) => facts.push(factOf('cardEdited', event)),
      onPromptBodySaved: (event) => facts.push(factOf('promptBodySaved', event)),
      onRelationCreated: (event) => facts.push(factOf('relationCreated', event)),
      onRelationNamed: (event) => facts.push(factOf('relationNamed', event)),
      onRelationDeleted: (event) => facts.push(factOf('relationDeleted', event)),
      onCanvasSaved: (event) => facts.push(factOf('canvasSaved', event)),
      onInputSummaryOpened: (event) => facts.push(factOf('inputSummaryOpened', event))
    }
    const commands = createWorkbenchCommands(client, observers)
    return { commands, calls, observers, facts }
  }

  it('编辑成功且确认用途非空才上报 cardEdited，空用途与失败不上报', async () => {
    const success = createCommands()
    const applied = await success.commands.editCard('img', {
      summary: '第一句旁白出现时亮出背景'
    })
    expect(applied).toBe('applied')
    expect(success.facts.map((fact) => fact.kind)).toEqual(['cardEdited'])
    expect(success.facts[0]).toMatchObject({ cardId: 'img', cardKind: 'image' })
    expect(success.facts[0]).not.toHaveProperty('summary')
    success.commands.dispose()

    const failure = createCommands({ editCardCode: 500 })
    const failed = await failure.commands.editCard('img', { summary: '写入失败的内容' })
    expect(failed).toBe('failed')
    expect(failure.facts).toHaveLength(0)
    failure.commands.dispose()
  })

  it('只改标题或清空用途不产生 cardEdited，普通编辑仍成功', async () => {
    const { commands, facts } = createCommands()
    expect(await commands.editCard('img', { title: '门口' })).toBe('applied')
    let image = useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === 'img')
    expect(image).toMatchObject({ title: '门口', summary: '' })
    expect(facts).toHaveLength(0)

    expect(await commands.editCard('img', { title: '门口', summary: '' })).toBe('applied')
    expect(facts).toHaveLength(0)

    expect(await commands.editCard('img', { title: '门口', summary: '推门时出现' })).toBe('applied')
    expect(facts.map((fact) => fact.kind)).toEqual(['cardEdited'])

    expect(await commands.editCard('img', { title: '门口', summary: '' })).toBe('applied')
    image = useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === 'img')
    expect(image).toMatchObject({ title: '门口', summary: '' })
    expect(facts).toHaveLength(1)
    commands.dispose()
  })

  it('初始用途非空时只改标题或原样重存不产生 cardEdited，用途实际变化后才上报', async () => {
    const { commands, facts } = createCommands()
    expect(await commands.editCard('img', { summary: '初始用途' })).toBe('applied')
    expect(facts.map((fact) => fact.kind)).toEqual(['cardEdited'])
    facts.splice(0)

    expect(await commands.editCard('img', { title: '只改标题' })).toBe('applied')
    expect(facts).toHaveLength(0)

    expect(await commands.editCard('img', { title: '门口', summary: '初始用途' })).toBe('applied')
    expect(facts).toHaveLength(0)

    expect(await commands.editCard('img', { title: '门口' })).toBe('applied')
    expect(facts).toHaveLength(0)

    expect(await commands.editCard('img', { summary: '推门后出现' })).toBe('applied')
    expect(facts.map((fact) => fact.kind)).toEqual(['cardEdited'])
    expect(facts[0]).toMatchObject({ cardId: 'img', cardKind: 'image' })
    commands.dispose()
  })

  it('切换工程后迟到的编辑结果为 dropped，不上报', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { commands, calls, facts } = createCommands({ editCardGate: gate })
    const pending = commands.editCard('img', { summary: '切换工程前写入' })
    await vi.waitFor(() => expect(calls.editCard).toBe(1))
    useWorkbenchSessionStore.getState().reset()
    release()
    await expect(pending).resolves.toBe('dropped')
    expect(facts).toHaveLength(0)
    commands.dispose()
  })

  it('连线成功上报两端身份，命名成功上报同一条线', async () => {
    const { commands, facts } = createCommands()
    await commands.connectCards('doc', 'img')
    await commands.editRelationName('rel-new', '人物与场景')
    expect(facts.map((fact) => fact.kind)).toEqual(['relationCreated', 'relationNamed'])
    expect(facts[0]).toMatchObject({
      relationId: 'rel-new',
      fromCardId: 'doc',
      toCardId: 'img',
      fromCardKind: 'document',
      toCardKind: 'image'
    })
    expect(facts[1]).toMatchObject({
      relationId: 'rel-new',
      fromCardId: 'doc',
      toCardId: 'img',
      fromCardKind: 'document',
      toCardKind: 'image'
    })
    commands.dispose()
  })

  it('删卡和删线成功上报旧对象身份，可直接让第 4 步回退重绑', async () => {
    const { commands, facts } = createCommands()
    expect(await commands.deleteCard('img')).toBe('applied')
    expect(facts.map((fact) => fact.kind)).toEqual(['cardDeleted'])
    expect(facts[0]).toMatchObject({ cardId: 'img', cardKind: 'image' })
    expect(useWorkbenchSessionStore.getState().cards.map((card) => card.cardId)).toEqual(['doc'])
    commands.dispose()

    const relation = createCommands()
    await relation.commands.connectCards('doc', 'img')
    relation.facts.splice(0)
    expect(await relation.commands.disconnectCards('rel-new')).toBe('applied')
    expect(relation.facts.map((fact) => fact.kind)).toEqual(['relationDeleted'])
    expect(relation.facts[0]).toMatchObject({
      relationId: 'rel-new',
      fromCardId: 'doc',
      toCardId: 'img',
      fromCardKind: 'document',
      toCardKind: 'image'
    })
    expect(useWorkbenchSessionStore.getState().relations).toHaveLength(0)
    relation.commands.dispose()
  })

  it('画布点选已放置的卡上报 cardSelected，空选和未知卡不上报', () => {
    const { commands, facts } = createCommands()
    commands.selectCard(null)
    commands.selectCard('missing')
    expect(facts).toHaveLength(0)

    commands.selectCard('img')
    expect(facts).toEqual([
      expect.objectContaining({
        kind: 'cardSelected',
        cardId: 'img',
        cardKind: 'image'
      })
    ])
    expect(facts[0]).not.toHaveProperty('sourceId')
    commands.dispose()
  })

  it('新建提示词卡上报 cardCreated，正文写盘成功后才上报 promptBodySaved', async () => {
    const { commands, facts } = createCommands()
    const promptId = await commands.createPromptCard({ x: 10, y: 10 })
    expect(promptId).not.toBeNull()
    expect(facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    expect(facts[0]).toMatchObject({ cardId: promptId, cardKind: 'prompt' })

    commands.editPromptBody(promptId as string, '保留原句顺序，到末句结束')
    expect(facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    await commands.flushPromptEdits()
    expect(facts.map((fact) => fact.kind)).toEqual(['cardCreated', 'promptBodySaved'])
    expect(facts[1]).toMatchObject({ cardId: promptId })

    commands.dispose()
  })

  it('正文保存失败或切换工程后不上报 promptBodySaved', async () => {
    const failing = createCommands({ promptBodyCode: 500 })
    const promptId = await failing.commands.createPromptCard({ x: 10, y: 10 })
    failing.commands.editPromptBody(promptId as string, '失败内容')
    await failing.commands.flushPromptEdits()
    expect(failing.facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    failing.commands.dispose()

    const switched = createCommands()
    const switchedPromptId = await switched.commands.createPromptCard({ x: 10, y: 10 })
    switched.commands.editPromptBody(switchedPromptId as string, '切换后的内容')
    useWorkbenchSessionStore.getState().reset()
    await switched.commands.flushPromptEdits()
    expect(switched.facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    switched.commands.dispose()
  })

  it('跨工程迟到的正文响应不合并旧结果，也不启动新工程自动保存', async () => {
    const gate = Promise.withResolvers<void>()
    const { commands, calls, facts } = createCommands({ promptBodyGate: gate.promise })
    const promptId = (await commands.createPromptCard({ x: 10, y: 10 })) as string
    facts.splice(0)

    commands.editPromptBody(promptId, '工程 A 的正文')
    const flush = commands.flushPromptEdits()
    await vi.waitFor(() => expect(calls.editPromptBody).toBe(1))

    startWorkbench('p-02')
    useWorkbenchSessionStore.getState().setViewport({ x: 30, y: 0, zoom: 1 })
    expect(useWorkbenchSessionStore.getState().saveState).toBe('dirty')
    // 切页时生产会释放旧工作台命令；在途响应仍可能迟到。
    commands.dispose()

    vi.useFakeTimers()
    try {
      gate.resolve()
      await flush
      await vi.advanceTimersByTimeAsync(31_000)
      expect(calls.save).toBe(0)
    } finally {
      vi.useRealTimers()
    }

    expect(facts).toHaveLength(0)
    expect(useWorkbenchSessionStore.getState().projectId).toBe('p-02')
    expect(useWorkbenchSessionStore.getState().viewport).toEqual({ x: 30, y: 0, zoom: 1 })
    commands.dispose()
  })

  it('空正文不推进，之后同一提示词正确保存仍上报并保留已有连线', async () => {
    const { commands, calls, facts } = createCommands()
    const promptId = (await commands.createPromptCard({ x: 10, y: 10 })) as string
    await commands.connectCards(promptId, 'doc')
    const relationId = useWorkbenchSessionStore.getState().relations[0]?.relationId
    facts.splice(0)

    commands.editPromptBody(promptId, '   ')
    await commands.flushPromptEdits()
    expect(calls.promptBodies).toEqual(['   '])
    expect(facts).toHaveLength(0)
    expect(
      useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === promptId)
    ).toMatchObject({ body: '   ' })

    commands.editPromptBody(promptId, '保留原句顺序，到末句结束')
    await commands.flushPromptEdits()
    expect(facts.map((fact) => fact.kind)).toEqual(['promptBodySaved'])
    expect(facts[0]).toMatchObject({ cardId: promptId })
    expect(
      useWorkbenchSessionStore.getState().relations.map((relation) => relation.relationId)
    ).toEqual([relationId])
    commands.dispose()
  })

  it('旧正文响应不推进，同一提示词最新保存才上报', async () => {
    const gate = Promise.withResolvers<void>()
    const { commands, calls, facts } = createCommands({ promptBodyGate: gate.promise })
    const promptId = (await commands.createPromptCard({ x: 10, y: 10 })) as string
    facts.splice(0)

    commands.editPromptBody(promptId, '第一次')
    const firstFlush = commands.flushPromptEdits()
    await vi.waitFor(() => expect(calls.editPromptBody).toBe(1))
    commands.editPromptBody(promptId, '第二次')
    gate.resolve()
    await firstFlush
    expect(facts).toHaveLength(0)
    expect(
      useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === promptId)
    ).toMatchObject({ body: '第二次' })

    await commands.flushPromptEdits()
    expect(calls.promptBodies).toEqual(['第一次', '第二次'])
    expect(facts.map((fact) => fact.kind)).toEqual(['promptBodySaved'])
    expect(facts[0]).toMatchObject({ cardId: promptId })
    commands.dispose()
  })

  it('撤销替代在途保存时不再上报 promptBodySaved', async () => {
    const gate = Promise.withResolvers<void>()
    const { commands, calls, facts } = createCommands({ promptBodyGate: gate.promise })
    const promptId = (await commands.createPromptCard({ x: 10, y: 10 })) as string
    facts.splice(0)

    commands.editPromptBody(promptId, '撤销前正文')
    const flush = commands.flushPromptEdits()
    await vi.waitFor(() => expect(calls.editPromptBody).toBe(1))
    commands.undo()
    gate.resolve()
    await flush
    expect(facts).toHaveLength(0)
    commands.dispose()
  })

  it('提示词 @ 引用不会被当成普通连线', async () => {
    const { commands, facts } = createCommands()
    const promptId = await commands.createPromptCard({ x: 10, y: 10 })
    commands.addPromptReference(promptId as string, 'doc')
    expect(facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    expect(facts.some((fact) => fact.kind === 'relationCreated')).toBe(false)
    commands.dispose()
  })

  it('生产拖入与文件区「在画布中使用」共用建卡成功点并上报 cardCreated', async () => {
    const direct = createCommands()
    useWorkbenchSessionStore.getState().setCatalog([summary('img-1', 'image')])
    await expect(
      direct.commands.createSourceCard('img-1', { x: 12, y: 16 })
    ).resolves.toBe('created')
    expect(direct.facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    expect(direct.facts[0]).toMatchObject({ cardKind: 'image' })
    direct.commands.dispose()

    const placed = createCommands()
    useWorkbenchSessionStore.getState().setCatalog([summary('aud-2', 'audio')])
    setActiveWorkbenchCommands(placed.commands)
    await placeSourceOnCanvas('aud-2')
    expect(placed.facts.map((fact) => fact.kind)).toEqual(['cardCreated'])
    expect(placed.facts[0]).toMatchObject({ cardKind: 'audio' })
    setActiveWorkbenchCommands(null)
    placed.commands.dispose()
  })

  it('打开文档层本身不上报，缓存/异步正文可显示后才上报 documentOpened', () => {
    const { commands, facts } = createCommands()
    commands.openDocumentLayer('img')
    expect(facts).toHaveLength(0)
    commands.openDocumentLayer('doc')
    expect(facts).toHaveLength(0)

    // 非当前层、未知卡或非文档卡都不发布阅读事实。
    commands.reportDocumentBodyReady('img')
    commands.reportDocumentBodyReady('missing')
    expect(facts).toHaveLength(0)

    commands.reportDocumentBodyReady('doc')
    expect(facts.map((fact) => fact.kind)).toEqual(['documentOpened'])

    // 关闭发布一次「回到画布」；空关闭不重复发布，之后迟到的正文读取也不再发布。
    commands.closeDocumentLayer()
    expect(facts.map((fact) => fact.kind)).toEqual(['documentOpened', 'documentClosed'])
    commands.closeDocumentLayer()
    commands.reportDocumentBodyReady('doc')
    expect(facts).toHaveLength(2)
    commands.dispose()
  })

  it('只有手动保存上报 canvasSaved，周期和生成前保存不上报', async () => {
    const { commands, facts, calls } = createCommands()
    commands.moveCards([{ cardId: 'doc', x: 20, y: 20 }])
    await commands.save('periodic')
    expect(calls.save).toBe(1)
    expect(facts).toHaveLength(0)

    commands.moveCards([{ cardId: 'doc', x: 30, y: 30 }])
    await commands.save('beforeGeneration')
    expect(calls.save).toBe(2)
    expect(facts).toHaveLength(0)

    commands.moveCards([{ cardId: 'doc', x: 40, y: 40 }])
    await commands.save('manual')
    expect(calls.save).toBe(3)
    expect(facts.map((fact) => fact.kind)).toEqual(['canvasSaved'])
    expect(facts[0]).toMatchObject({ scope: SCOPE })
    commands.dispose()
  })

  it('没有改动时手动保存也上报一次 canvasSaved', async () => {
    const { commands, facts, calls } = createCommands()
    await commands.save('manual')
    expect(calls.save).toBe(0)
    expect(facts.map((fact) => fact.kind)).toEqual(['canvasSaved'])
    expect(facts[0]).toMatchObject({ scope: SCOPE })
    commands.dispose()
  })

  it('导出前保存不上报 canvasSaved', async () => {
    const { commands, facts, calls } = createCommands()
    commands.moveCards([{ cardId: 'doc', x: 20, y: 20 }])
    await commands.save('manual', { reportGuide: false })
    expect(calls.save).toBe(1)
    expect(facts).toHaveLength(0)
    commands.dispose()
  })

  it('导出前保存即使没有改动也不上报 canvasSaved', async () => {
    const { commands, facts, calls } = createCommands()
    await commands.save('manual', { reportGuide: false })
    expect(calls.save).toBe(0)
    expect(facts).toHaveLength(0)
    commands.dispose()
  })

  it('抑制参数只影响本次导出保存，随后的手动保存仍上报', async () => {
    const { commands, facts, calls } = createCommands()
    commands.moveCards([{ cardId: 'doc', x: 20, y: 20 }])
    await commands.save('manual', { reportGuide: false })
    expect(calls.save).toBe(1)
    expect(facts).toHaveLength(0)

    commands.moveCards([{ cardId: 'doc', x: 30, y: 30 }])
    await commands.save('manual')
    expect(calls.save).toBe(2)
    expect(facts.map((fact) => fact.kind)).toEqual(['canvasSaved'])
    commands.dispose()
  })
})

describe('目录导入：只在真实成功时回调', () => {
  function setupImport(options?: {
    chosen?: readonly string[] | null
    importResult?: AjaxResult<{
      importedFiles: readonly {
        sourceId: string
        name: string
        readable: boolean
        parentFolderId: string | null
        contentKind: 'text'
        textKind: 'document'
      }[]
      failedFiles: readonly { fileName: string; message: string }[]
    }>
  }): {
    client: ProjectFilesClient
    imported: ImportedSourceAction[]
  } {
    startWorkbench()
    const imported: ImportedSourceAction[] = []
    const client = {
      chooseProjectFiles: async () => ok(options?.chosen ?? null),
      importProjectFiles: async () =>
        options?.importResult ??
        ok({
          importedFiles: [
            {
              sourceId: 'src-1',
              name: '剧本.md',
              readable: true,
              parentFolderId: null,
              contentKind: 'text' as const,
              textKind: 'document' as const
            }
          ],
          failedFiles: []
        }),
      listProjectInputSources: async () => ok({ sources: [], catalogVersion: 'catalog-1' })
    } as unknown as ProjectFilesClient
    return { client, imported }
  }

  it('导入成功后回传导入的来源', async () => {
    const { client, imported } = setupImport({ chosen: ['C:/tmp/剧本.md'] })
    const outcome = await chooseAndImport(
      client,
      new QueryClient(),
      'p-01',
      null,
      false,
      () => undefined,
      (sources) => imported.push(...sources)
    )
    expect(imported).toEqual([
      { projectId: 'p-01', sourceId: 'src-1', contentKind: 'text', candidateKind: null }
    ])
    expect(outcome).toEqual({
      status: 'imported',
      sources: [
        { projectId: 'p-01', sourceId: 'src-1', contentKind: 'text', candidateKind: null }
      ]
    })
  })

  it('取消选择不回调', async () => {
    const { client, imported } = setupImport({ chosen: null })
    const outcome = await chooseAndImport(
      client,
      new QueryClient(),
      'p-01',
      null,
      false,
      () => undefined,
      (sources) => imported.push(...sources)
    )
    expect(imported).toEqual([])
    expect(outcome).toEqual({ status: 'cancelled' })
  })

  it('导入失败不回调', async () => {
    const { client, imported } = setupImport({
      chosen: ['C:/tmp/剧本.md'],
      importResult: { code: 500, msg: '导入失败', data: null }
    })
    const outcome = await chooseAndImport(
      client,
      new QueryClient(),
      'p-01',
      null,
      false,
      () => undefined,
      (sources) => imported.push(...sources)
    )
    expect(imported).toEqual([])
    expect(outcome).toEqual({ status: 'none' })
  })

  it('提交不明但恢复确认已提交时，只重载目录，不按差集发布本次来源', async () => {
    startWorkbench()
    useWorkbenchSessionStore.getState().setCatalog([
      {
        sourceId: 'src-old',
        name: '旧文件.md',
        readable: true,
        parentFolderId: null,
        contentKind: 'text',
        textKind: 'document'
      }
    ])
    const imported: ImportedSourceAction[] = []
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/新剧本.md']),
      importProjectFiles: async () => ({
        code: COMMIT_UNCLEAR_CODE,
        msg: '提交结果不明',
        data: null
      }),
      recoverProjectFileOperations: async (request: { operationIds: readonly string[] }) =>
        ok(
          request.operationIds.map((operationId) => ({ operationId, state: 'committed' as const }))
        ),
      listProjectInputSources: async () =>
        ok({
          projectId: 'p-01',
          catalogVersion: 'catalog-2',
          folders: [],
          sources: [
            {
              sourceId: 'src-old',
              name: '旧文件.md',
              readable: true,
              parentFolderId: null,
              contentKind: 'text' as const,
              textKind: 'document' as const
            },
            {
              sourceId: 'src-new',
              name: '新剧本.md',
              readable: true,
              parentFolderId: null,
              contentKind: 'text' as const,
              textKind: 'document' as const
            }
          ]
        })
    } as unknown as ProjectFilesClient

    const outcome = await chooseAndImport(
      client,
      new QueryClient(),
      'p-01',
      null,
      false,
      () => undefined,
      (sources) => imported.push(...sources)
    )

    expect(imported).toEqual([])
    expect(outcome).toEqual({ status: 'unconfirmed' })
    expect(useWorkbenchSessionStore.getState().sources.map((source) => source.sourceId)).toEqual([
      'src-old',
      'src-new'
    ])
  })

  it('恢复结果没有已提交文件时不发布导入事实', async () => {
    startWorkbench()
    useWorkbenchSessionStore.getState().setCatalog([
      {
        sourceId: 'src-old',
        name: '旧文件.md',
        readable: true,
        parentFolderId: null,
        contentKind: 'text',
        textKind: 'document'
      }
    ])
    const imported: ImportedSourceAction[] = []
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/新剧本.md']),
      importProjectFiles: async () => ({
        code: COMMIT_UNCLEAR_CODE,
        msg: '提交结果不明',
        data: null
      }),
      recoverProjectFileOperations: async (request: { operationIds: readonly string[] }) =>
        ok(
          request.operationIds.map((operationId) => ({
            operationId,
            state: 'notCommitted' as const
          }))
        ),
      listProjectInputSources: async () =>
        ok({
          projectId: 'p-01',
          catalogVersion: 'catalog-2',
          folders: [],
          sources: [
            {
              sourceId: 'src-old',
              name: '旧文件.md',
              readable: true,
              parentFolderId: null,
              contentKind: 'text' as const,
              textKind: 'document' as const
            }
          ]
        })
    } as unknown as ProjectFilesClient

    const outcome = await chooseAndImport(
      client,
      new QueryClient(),
      'p-01',
      null,
      false,
      () => undefined,
      (sources) => imported.push(...sources)
    )

    expect(imported).toEqual([])
    expect(outcome).toEqual({ status: 'none' })
  })
})

describe('按类型导入', () => {
  it('按类型导入把可选类型交给现有选择器，普通导入不传过滤', async () => {
    const typedChooser = vi.fn(async () => ok(null))
    const typedClient = {
      chooseProjectFiles: typedChooser
    } as unknown as ProjectFilesClient
    const typed = await importWith(typedClient, { mediaKinds: ['audio'] })
    expect(typedChooser).toHaveBeenCalledWith({ mediaKinds: ['audio'] })
    expect(typed).toEqual({ status: 'cancelled' })

    const normalChooser = vi.fn(async () => ok(null))
    const normalClient = {
      chooseProjectFiles: normalChooser
    } as unknown as ProjectFilesClient
    const normal = await importWith(normalClient)
    expect(normalChooser).toHaveBeenCalledWith()
    expect(normal).toEqual({ status: 'cancelled' })
  })

  it('用户触发动作把所需类别交给文件区导入并映射结果', async () => {
    const importFiles = vi.fn(
      async (): Promise<CatalogImportOutcome> => ({
        status: 'imported',
        sources: [
          {
            projectId: 'p-01',
            sourceId: 'src-aud',
            contentKind: 'audio',
            candidateKind: 'audio'
          }
        ]
      })
    )
    const action = guideMediaImportActionOf(importFiles)
    await expect(action('audio')).resolves.toBe('imported')
    expect(importFiles).toHaveBeenCalledWith({ mediaKinds: ['audio'] })

    importFiles.mockResolvedValueOnce({ status: 'cancelled' })
    await expect(action('audio')).resolves.toBe('cancelled')
  })

  it('选错类型不报告所选类别成功，混合导入只按真实来源类别匹配', async () => {
    const wrongImported: ImportedSourceAction[] = []
    const wrongClient = {
      chooseProjectFiles: async () => ok(['C:/tmp/图.png']),
      importProjectFiles: async () =>
        ok({ importedFiles: [summary('src-img', 'image')], failedFiles: [] }),
      listProjectInputSources: async () =>
        ok({
          projectId: 'p-01',
          catalogVersion: 'catalog-2',
          folders: [],
          sources: [summary('src-img', 'image')]
        })
    } as unknown as ProjectFilesClient
    const wrong = await importWith(wrongClient, {
      mediaKinds: ['audio'],
      onImported: (sources) => wrongImported.push(...sources)
    })
    expect(guideMediaImportOutcomeOf(wrong, 'audio')).toBe('wrong-kind')
    expect(wrongImported).toEqual([
      { projectId: 'p-01', sourceId: 'src-img', contentKind: 'image', candidateKind: 'image' }
    ])

    const mixedImported: ImportedSourceAction[] = []
    const mixedClient = {
      chooseProjectFiles: async () => ok(['C:/tmp/图.png', 'C:/tmp/声.wav']),
      importProjectFiles: async () =>
        ok({
          importedFiles: [summary('src-img', 'image'), summary('src-aud', 'audio')],
          failedFiles: []
        }),
      listProjectInputSources: async () => ok({ sources: [], catalogVersion: 'catalog-2' })
    } as unknown as ProjectFilesClient
    const mixed = await importWith(mixedClient, {
      mediaKinds: ['audio'],
      onImported: (sources) => mixedImported.push(...sources)
    })
    expect(guideMediaImportOutcomeOf(mixed, 'audio')).toBe('imported')
    expect(mixedImported.map((source) => source.contentKind)).toEqual(['image', 'audio'])
  })

  it('未知后缀的真实图片可普通导入，但不提示当拍目标成功', async () => {
    const imported: ImportedSourceAction[] = []
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/画面.xyz']),
      importProjectFiles: async () =>
        ok({ importedFiles: [summary('src-xyz', 'image', '画面.xyz')], failedFiles: [] }),
      listProjectInputSources: async () => ok({ sources: [], catalogVersion: 'catalog-2' })
    } as unknown as ProjectFilesClient
    const outcome = await importWith(client, {
      mediaKinds: ['image'],
      onImported: (sources) => imported.push(...sources)
    })

    // 普通导入仍成功并发布来源，用户仍可自行拖卡。
    expect(outcome).toEqual({
      status: 'imported',
      sources: [
        { projectId: 'p-01', sourceId: 'src-xyz', contentKind: 'image', candidateKind: null }
      ]
    })
    expect(imported).toEqual([
      { projectId: 'p-01', sourceId: 'src-xyz', contentKind: 'image', candidateKind: null }
    ])
    // 回执不把文件名交给教程，只带类别与候选结论。
    if (outcome.status === 'imported') {
      expect(outcome.sources[0]).not.toHaveProperty('name')
    }
    // 教程回执使用同一候选规则：未知后缀不算当前「导入图片」动作成功。
    expect(guideMediaImportOutcomeOf(outcome, 'image')).toBe('wrong-kind')
  })

  it('恢复已提交但导入前目录基线未知时不发来源事实，只重载目录供用户拖卡', async () => {
    const imported: ImportedSourceAction[] = []
    let catalogReloaded = false
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/新音效.wav']),
      importProjectFiles: async () => ({
        code: COMMIT_UNCLEAR_CODE,
        msg: '提交结果不明',
        data: null
      }),
      recoverProjectFileOperations: async (request: { operationIds: readonly string[] }) =>
        ok(
          request.operationIds.map((operationId) => ({ operationId, state: 'committed' as const }))
        ),
      listProjectInputSources: async () => {
        catalogReloaded = true
        return ok({
          projectId: 'p-01',
          catalogVersion: 'catalog-2',
          folders: [],
          sources: [summary('src-aud', 'audio')]
        })
      }
    } as unknown as ProjectFilesClient

    const outcome = await importWith(client, {
      mediaKinds: ['audio'],
      onImported: (sources) => imported.push(...sources)
    })

    expect(outcome).toEqual({ status: 'unconfirmed' })
    expect(imported).toEqual([])
    expect(catalogReloaded).toBe(true)
    expect(useWorkbenchSessionStore.getState().sources).toEqual([summary('src-aud', 'audio')])
  })

  it('恢复待核对时即使有已提交计数也不发来源事实，并重载目录', async () => {
    const imported: ImportedSourceAction[] = []
    let catalogReloaded = false
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/甲.wav', 'C:/tmp/乙.wav']),
      importProjectFiles: async () => ({
        code: COMMIT_UNCLEAR_CODE,
        msg: '提交结果不明',
        data: null
      }),
      recoverProjectFileOperations: async (request: { operationIds: readonly string[] }) =>
        ok([{ operationId: request.operationIds[0]!, state: 'committed' as const }]),
      listProjectInputSources: async () => {
        catalogReloaded = true
        return ok({
          projectId: 'p-01',
          catalogVersion: 'catalog-2',
          folders: [],
          sources: [summary('src-aud', 'audio')]
        })
      }
    } as unknown as ProjectFilesClient

    const outcome = await importWith(client, {
      mediaKinds: ['audio'],
      onImported: (sources) => imported.push(...sources)
    })

    expect(outcome).toEqual({ status: 'unconfirmed' })
    expect(imported).toEqual([])
    expect(catalogReloaded).toBe(true)
  })
})

function factOf(kind: GuideFact['kind'], event: unknown): GuideFact {
  const scope = (event as { scope?: unknown }).scope
  return {
    kind,
    scope: scope as GuideFact['scope'],
    outcome: 'confirmed',
    sequence: 1,
    occurredAt: '2026-11-22T10:00:00.000Z',
    ...(event as object)
  } as GuideFact
}
