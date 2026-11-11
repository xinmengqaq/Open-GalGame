import { beforeEach, describe, expect, it } from 'vitest'

import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '@presentation/features/workbench-session/workbenchSession.store'
import {
  draftFingerprint,
  snapshotOf
} from '@presentation/features/workbench-session/workbenchSessionMapper'
import type { WorkbenchSessionState } from '@presentation/features/workbench-session/workbenchSession.types'
import { workbenchStateOf } from '@presentation/features/workbench-session/workbenchState'

function arrangement(): SceneCanvasArrangementVO {
  return {
    projectId: 'p-01',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 0.9 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'doc-1',
        title: '角色设定',
        summary: '简介',
        layout: { x: 10, y: 20, width: 300, height: 224 }
      },
      {
        kind: 'image',
        cardId: 'img',
        sourceId: 'img-1',
        role: 'background',
        title: '屋顶',
        summary: '',
        layout: { x: 320, y: 20, width: 320, height: 208 }
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        body: '旧正文',
        references: [],
        layout: { x: 10, y: 260, width: 320, height: 252 }
      }
    ],
    relations: [
      {
        relationId: 'rel-1',
        fromCardId: 'doc',
        toCardId: 'img',
        specificName: '同一场景',
        recordCardId: 'doc'
      }
    ]
  }
}

function start(): WorkbenchSessionState {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId: 'p-01',
    projectName: '未寄出的第二封信',
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
  useWorkbenchSessionStore.getState().setArrangement(arrangement())
  return useWorkbenchSessionStore.getState()
}

describe('工作台会话', () => {
  beforeEach(() => {
    start()
  })

  it('读取编排恢复视口并以已保存内容为基线', () => {
    const state = useWorkbenchSessionStore.getState()
    expect(state.arrangementStatus).toBe('ready')
    expect(state.saveState).toBe('saved')
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 0.9 })
    expect(sessionIsDirty(state)).toBe(false)
    expect(state.cards.map((card) => card.cardId)).toEqual(['doc', 'img', 'prompt'])
  })

  it('会话身份来自调用方传入的工作区，不回落到固定场景', () => {
    useWorkbenchSessionStore.getState().reset()
    expect(useWorkbenchSessionStore.getState()).toMatchObject({ sceneId: '', canvasId: '' })
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-09',
      projectName: '另一场',
      sceneId: 'scene-returned',
      canvasId: 'canvas-returned'
    })
    expect(useWorkbenchSessionStore.getState()).toMatchObject({
      projectId: 'p-09',
      sceneId: 'scene-returned',
      canvasId: 'canvas-returned'
    })
  })

  it('移动多张卡片只记一次历史，撤销和重做恢复布局与视口', () => {
    const store = useWorkbenchSessionStore.getState()
    store.moveCards([
      { cardId: 'doc', x: 88, y: 99 },
      { cardId: 'img', x: 400, y: 120 }
    ])
    store.setViewport({ x: 30, y: 40, zoom: 1.2 })
    let state = useWorkbenchSessionStore.getState()
    expect(state.past).toHaveLength(1)
    expect(state.cards.find((card) => card.cardId === 'doc')?.layout).toMatchObject({
      x: 88,
      y: 99
    })
    expect(sessionIsDirty(state)).toBe(true)
    expect(state.saveState).toBe('dirty')

    store.undo()
    state = useWorkbenchSessionStore.getState()
    expect(state.cards.find((card) => card.cardId === 'doc')?.layout).toMatchObject({
      x: 10,
      y: 20
    })
    expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 0.9 })
    expect(sessionIsDirty(state)).toBe(false)

    store.redo()
    state = useWorkbenchSessionStore.getState()
    expect(state.cards.find((card) => card.cardId === 'doc')?.layout).toMatchObject({
      x: 88,
      y: 99
    })
    expect(state.viewport).toEqual({ x: 30, y: 40, zoom: 1.2 })
  })

  it('位置未变不记历史，视口单独变化不进撤销栈', () => {
    const store = useWorkbenchSessionStore.getState()
    store.moveCards([{ cardId: 'doc', x: 10, y: 20 }])
    store.setViewport({ x: 4, y: 6, zoom: 0.9 })
    const state = useWorkbenchSessionStore.getState()
    expect(state.past).toHaveLength(0)
    expect(sessionIsDirty(state)).toBe(true)
  })

  it('提示词草稿只在首次输入时记一次撤销', () => {
    const store = useWorkbenchSessionStore.getState()
    expect(store.setPromptBodyDraft('prompt', '新', true)).toBe(true)
    expect(store.setPromptBodyDraft('prompt', '新正文', false)).toBe(true)
    const state = useWorkbenchSessionStore.getState()
    expect(state.past).toHaveLength(1)
    expect(state.cards.find((card) => card.cardId === 'prompt')).toMatchObject({ body: '新正文' })
    expect(sessionIsDirty(state)).toBe(true)
  })

  it('提示词卡缩放写入布局并进入保存内容', () => {
    const store = useWorkbenchSessionStore.getState()
    const before = draftFingerprint(store.cards, store.relations, store.viewport)
    expect(store.resizeCard('prompt', { x: 10, y: 260, width: 480, height: 360 })).toBe(true)
    const state = useWorkbenchSessionStore.getState()
    const prompt = state.cards.find((card) => card.cardId === 'prompt')
    expect(prompt?.layout).toEqual({ x: 10, y: 260, width: 480, height: 360 })
    expect(state.past).toHaveLength(1)
    expect(sessionIsDirty(state)).toBe(true)
    expect(draftFingerprint(state.cards, state.relations, state.viewport)).not.toBe(before)
    expect(snapshotOf(state).cards.find((card) => card.cardId === 'prompt')?.layout).toEqual({
      x: 10,
      y: 260,
      width: 480,
      height: 360
    })
    expect(state.resizeCard('prompt', { x: 10, y: 260, width: 480, height: 360 })).toBe(false)
  })

  it('旧响应保留请求之后的内容和布局，同时接受新卡片', () => {
    const store = useWorkbenchSessionStore.getState()
    const capture = { revision: store.revision, structuralRevision: store.structuralRevision }
    store.setPromptBodyDraft('prompt', '本地新正文', false)
    store.moveCards([{ cardId: 'doc', x: 200, y: 220 }])
    const server = arrangement()
    server.relations = []
    server.cards = [
      ...server.cards.map((card) =>
        card.cardId === 'doc' ? { ...card, layout: { ...card.layout, x: 0, y: 0 } } : card
      ),
      {
        kind: 'effect',
        cardId: 'fx-new',
        webgalPreset: null,
        layout: { x: 600, y: 40, width: 296, height: 188 }
      }
    ]
    store.applyServerArrangement(server, capture)
    const state = useWorkbenchSessionStore.getState()
    expect(state.cards.find((card) => card.cardId === 'prompt')).toMatchObject({
      body: '本地新正文'
    })
    expect(state.cards.find((card) => card.cardId === 'doc')?.layout.x).toBe(200)
    expect(state.cards.find((card) => card.cardId === 'fx-new')).toBeDefined()
    expect(state.selectedCardId).toBe('fx-new')
  })

  it('结构在响应之前变化时整份丢弃旧响应', () => {
    const store = useWorkbenchSessionStore.getState()
    const capture = { revision: store.revision, structuralRevision: store.structuralRevision }
    const first = arrangement()
    first.cards = [
      ...first.cards,
      {
        kind: 'animation',
        cardId: 'anim',
        webgalPreset: null,
        layout: { x: 600, y: 40, width: 296, height: 188 }
      }
    ]
    store.applyServerArrangement(first, capture)
    expect(useWorkbenchSessionStore.getState().cards).toHaveLength(4)
    const stale = arrangement()
    stale.cards = stale.cards.slice(0, 1)
    expect(store.applyServerArrangement(stale, capture)).toBe(false)
    expect(useWorkbenchSessionStore.getState().cards).toHaveLength(4)
  })

  it('服务端编排写入卡片后，顶栏按卡片数而不是旧的空状态显示', () => {
    const store = useWorkbenchSessionStore.getState()
    store.setArrangementEmpty()
    const capture = {
      revision: useWorkbenchSessionStore.getState().revision,
      structuralRevision: useWorkbenchSessionStore.getState().structuralRevision
    }
    store.applyServerArrangement(arrangement(), capture)
    const applied = useWorkbenchSessionStore.getState()
    expect(applied.arrangementStatus).toBe('empty')
    expect(applied.cards.length).toBeGreaterThan(0)
    expect(
      workbenchStateOf({
        catalogStatus: applied.catalogStatus,
        catalogError: applied.catalogError,
        arrangementStatus: applied.arrangementStatus,
        arrangementError: applied.arrangementError,
        arrangementCardCount: applied.cards.length
      }).title
    ).toBe('工程与画布已就绪')
  })

  it('保存成功以发送快照为基线，保存期间的新编辑仍为未保存', () => {
    const store = useWorkbenchSessionStore.getState()
    store.moveCards([{ cardId: 'doc', x: 60, y: 70 }])
    const sentState = useWorkbenchSessionStore.getState()
    const sent = {
      cards: sentState.cards,
      relations: sentState.relations,
      viewport: sentState.viewport
    }
    store.markSaving()
    expect(useWorkbenchSessionStore.getState().saveState).toBe('saving')
    store.setPromptBodyDraft('prompt', '保存期间输入', false)
    store.markSaved(sent)
    const state = useWorkbenchSessionStore.getState()
    expect(state.saveState).toBe('dirty')
    expect(sessionIsDirty(state)).toBe(true)
  })

  it('保存失败状态与空画布、读取失败分开', () => {
    const store = useWorkbenchSessionStore.getState()
    store.markSaveFailure('unverified', { code: 4413, msg: '提交结果不明' })
    expect(useWorkbenchSessionStore.getState().saveState).toBe('unverified')
    store.setArrangementEmpty()
    expect(useWorkbenchSessionStore.getState().arrangementStatus).toBe('empty')
    expect(useWorkbenchSessionStore.getState().saveState).toBe('idle')
    store.setArrangementFailure({ code: 4416, msg: '编排内容损坏' })
    const failed = useWorkbenchSessionStore.getState()
    expect(failed.arrangementStatus).toBe('failed')
    expect(failed.arrangementError?.code).toBe(4416)
    expect(failed.baseline).toBeNull()
  })

  it('来源目录刷新只更新来源事实，不改卡片内容', () => {
    const store = useWorkbenchSessionStore.getState()
    store.setCatalog([
      {
        sourceId: 'doc-1',
        name: '角色设定.md',
        readable: true,
        parentFolderId: null,
        contentKind: 'text',
        textKind: 'document'
      }
    ])
    const card = useWorkbenchSessionStore.getState().cards[0]
    expect(card).toMatchObject({ cardId: 'doc', title: '角色设定', summary: '简介' })
    expect(sessionIsDirty(useWorkbenchSessionStore.getState())).toBe(false)
  })

  it('恢复撤销前草稿成为新的未保存编辑，不恢复旧撤销栈', () => {
    const store = useWorkbenchSessionStore.getState()
    store.moveCards([{ cardId: 'doc', x: 88, y: 99 }])
    const draft = snapshotOf(useWorkbenchSessionStore.getState())
    const reverted = arrangement()
    useWorkbenchSessionStore.getState().setArrangement(reverted)
    expect(useWorkbenchSessionStore.getState().cards[0]?.layout).toMatchObject({ x: 10, y: 20 })

    useWorkbenchSessionStore.getState().restoreSessionDraft(draft)
    const restored = useWorkbenchSessionStore.getState()
    expect(restored.cards[0]?.layout).toMatchObject({ x: 88, y: 99 })
    expect(restored.past).toHaveLength(0)
    expect(restored.future).toHaveLength(0)
    expect(restored.saveState).toBe('dirty')
    expect(sessionIsDirty(restored)).toBe(true)
  })
})
