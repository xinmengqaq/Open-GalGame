import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { SaveSceneCanvasArrangementDTO } from '@application/scene-canvas/dto/SceneCanvasDTO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  PROJECT_WORKSPACE_NOT_READY_CODE,
  workbenchFeedback
} from '@presentation/feedback/workbenchFeedback'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import {
  createWorkbenchCommands,
  type WorkbenchCommands
} from '@presentation/features/workbench-session/workbenchCommands'
import { saveStatusOf } from '@presentation/features/workbench-session/workbenchSaveStatus'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '@presentation/features/workbench-session/workbenchSession.store'
import {
  loadArrangement,
  openWorkbenchWorkspace,
  refreshSources
} from '@presentation/pages/workbench/useWorkbenchPage'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
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
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        body: '旧正文',
        references: [],
        layout: { x: 0, y: 260, width: 320, height: 252 }
      }
    ],
    relations: []
  }
}

function startSession(): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId: 'p-01',
    projectName: '未寄出的第二封信',
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
  useWorkbenchSessionStore.getState().setArrangement(arrangement())
}

interface FakeCalls {
  editCard: number
  deleteCard: number
  editPromptBody: number
  save: SaveSceneCanvasArrangementDTO[]
}

function createFakeClient(options?: {
  editCardGate?: Promise<void>
  editCardCode?: number
  promptGate?: Promise<void>
  saveCode?: number
  promptResponseBody?: string
}): { client: SceneCanvasClient; calls: FakeCalls } {
  const calls: FakeCalls = { editCard: 0, deleteCard: 0, editPromptBody: 0, save: [] }
  const echo = (request: { arrangement: SceneCanvasArrangementVO }): SceneCanvasArrangementVO =>
    structuredClone(request.arrangement)
  const client = {
    editCard: async (request: {
      arrangement: SceneCanvasArrangementVO
      cardId: string
      title?: string
      summary?: string
    }) => {
      calls.editCard += 1
      if (options?.editCardGate) await options.editCardGate
      if (options?.editCardCode) {
        return { code: options.editCardCode, msg: '标题没有写入', data: null }
      }
      const next = echo(request)
      next.cards = next.cards.map((card) =>
        card.cardId === request.cardId && card.kind === 'document'
          ? {
              ...card,
              title: request.title ?? card.title,
              summary: request.summary ?? card.summary
            }
          : card
      )
      return ok(next)
    },
    deleteCard: async (request: { arrangement: SceneCanvasArrangementVO; cardId: string }) => {
      calls.deleteCard += 1
      const next = echo(request)
      next.cards = next.cards.filter((card) => card.cardId !== request.cardId)
      return ok(next)
    },
    editPromptBody: async (request: {
      arrangement: SceneCanvasArrangementVO
      cardId: string
      body: string
    }) => {
      calls.editPromptBody += 1
      if (options?.promptGate) await options.promptGate
      const next = echo(request)
      next.cards = next.cards.map((card) =>
        card.cardId === request.cardId && card.kind === 'prompt'
          ? { ...card, body: options?.promptResponseBody ?? request.body }
          : card
      )
      return ok(next)
    },
    saveSceneCanvasArrangement: async (request: SaveSceneCanvasArrangementDTO) => {
      calls.save.push(request)
      if (options?.saveCode && options.saveCode !== ErrorCodes.success) {
        return { code: options.saveCode, msg: '保存失败' }
      }
      return ok(null)
    }
  } as unknown as SceneCanvasClient
  return { client, calls }
}

function commandsFor(client: SceneCanvasClient): WorkbenchCommands {
  return createWorkbenchCommands(client)
}

describe('工作台命令', () => {
  let commands: WorkbenchCommands | null = null

  beforeEach(() => {
    vi.mocked(toast).mockReset()
    vi.useRealTimers()
    startSession()
  })

  afterEach(() => {
    commands?.dispose()
    commands = null
    vi.useRealTimers()
  })

  it('编辑请求串行执行，后一个请求等前一个响应', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { client, calls } = createFakeClient({ editCardGate: gate })
    commands = commandsFor(client)
    const first = commands.editCard('doc', { title: '新标题' })
    const second = commands.deleteCard('img')
    await vi.waitFor(() => expect(calls.editCard).toBe(1))
    expect(calls.deleteCard).toBe(0)
    release()
    await Promise.all([first, second])
    expect(calls.deleteCard).toBe(1)
    expect(useWorkbenchSessionStore.getState().cards.map((card) => card.cardId)).toEqual([
      'doc',
      'prompt'
    ])
  })

  it('撤销作废的编辑响应不算应用成功，也不报成新的失败', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { client, calls } = createFakeClient({ editCardGate: gate })
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 48, y: 12 }])
    const pending = commands.editCard('doc', { title: '迟到标题' })
    await vi.waitFor(() => expect(calls.editCard).toBe(1))
    useWorkbenchSessionStore.getState().undo()
    release()
    expect(await pending).toBe('dropped')
    expect(
      useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === 'doc')
    ).toMatchObject({ title: '角色' })
    expect(toast).not.toHaveBeenCalled()
  })

  it('工程已切换时迟到编辑被作废，不提示保存失败', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { client, calls } = createFakeClient({ editCardGate: gate })
    commands = commandsFor(client)
    const pending = commands.editCard('doc', { title: '旧工程标题' })
    await vi.waitFor(() => expect(calls.editCard).toBe(1))
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-02',
      projectName: '另一封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    release()
    expect(await pending).toBe('dropped')
    expect(useWorkbenchSessionStore.getState().projectId).toBe('p-02')
    expect(toast).not.toHaveBeenCalled()
  })

  it('编辑请求失败保持原标题并返回失败', async () => {
    const { client } = createFakeClient({ editCardCode: 500 })
    commands = commandsFor(client)
    expect(await commands.editCard('doc', { title: '写不进去' })).toBe('failed')
    expect(
      useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === 'doc')
    ).toMatchObject({ title: '角色' })
    expect(toast).toHaveBeenCalled()
  })

  it('较晚输入不被较早响应覆盖', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { client, calls } = createFakeClient({ promptGate: gate, promptResponseBody: '第一次' })
    commands = commandsFor(client)
    commands.editPromptBody('prompt', '第一次')
    const flush = commands.flushPromptEdits()
    await vi.waitFor(() => expect(calls.editPromptBody).toBe(1))
    commands.editPromptBody('prompt', '第二次')
    release()
    await flush
    expect(
      useWorkbenchSessionStore.getState().cards.find((card) => card.cardId === 'prompt')
    ).toMatchObject({ body: '第二次' })
  })

  it('保存失败按错误码映射为未保存、已落盘未提交、结果待核对', async () => {
    const codes = [4411, 4412, 4413]
    const expected = ['unsaved', 'committedUnsubmitted', 'unverified']
    for (const [index, code] of codes.entries()) {
      startSession()
      const { client, calls } = createFakeClient({ saveCode: code })
      commands = commandsFor(client)
      commands.moveCards([{ cardId: 'doc', x: 40, y: 50 }])
      await commands.save('manual')
      const state = useWorkbenchSessionStore.getState()
      expect(state.saveState).toBe(expected[index])
      expect(calls.save).toHaveLength(1)
      expect(calls.save[0]?.reason).toBe('manual')
      expect(calls.save[0]?.arrangement.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
      expect(calls.save[0]?.arrangement.cards[0]?.layout).toMatchObject({ x: 40, y: 50 })
      commands.dispose()
    }
  })

  it('工作区未就绪的保存保留编辑，并使用安全文案', async () => {
    startSession()
    const { client } = createFakeClient({ saveCode: PROJECT_WORKSPACE_NOT_READY_CODE })
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 40, y: 50 }])
    await commands.save('manual')
    const state = useWorkbenchSessionStore.getState()
    expect(state.saveError).toEqual({
      code: PROJECT_WORKSPACE_NOT_READY_CODE,
      msg: '工程初始化未完成，请重新构建'
    })
    expect(state.cards[0]?.layout).toMatchObject({ x: 40, y: 50 })
    expect(state.arrangementStatus).toBe('ready')
    commands.dispose()
  })

  it('结果待核对持续显示，不用成功文案掩盖', async () => {
    const { client } = createFakeClient({ saveCode: 4413 })
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 40, y: 50 }])
    await commands.save('manual')
    const status = saveStatusOf(useWorkbenchSessionStore.getState())
    expect(status.label).toBe('结果待核对')
    expect(status.detail).toBe(workbenchFeedback.saveUnverified)
    expect(toast).not.toHaveBeenCalledWith(workbenchFeedback.saveSucceeded)
  })

  it('通信失败记为结果待核对，之后的本地编辑不再安排普通自动保存', async () => {
    vi.useFakeTimers()
    const { client, calls } = createFakeClient({ saveCode: ErrorCodes.communicationFailed })
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 40, y: 50 }])
    await commands.save('manual')
    const failed = useWorkbenchSessionStore.getState()
    expect(failed.saveState).toBe('unverified')
    expect(failed.cards[0]?.layout).toMatchObject({ x: 40, y: 50 })
    expect(saveStatusOf(failed).label).toBe('结果待核对')
    expect(calls.save).toHaveLength(1)

    commands.moveCards([{ cardId: 'doc', x: 80, y: 90 }])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.save).toHaveLength(1)
    expect(useWorkbenchSessionStore.getState().saveState).toBe('unverified')
    expect(useWorkbenchSessionStore.getState().cards[0]?.layout).toMatchObject({ x: 80, y: 90 })
  })

  it('确定失败保持未保存，后续本地编辑仍安排普通自动保存', async () => {
    vi.useFakeTimers()
    const { client, calls } = createFakeClient({ saveCode: 4411 })
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 40, y: 50 }])
    await commands.save('manual')
    expect(useWorkbenchSessionStore.getState().saveState).toBe('unsaved')
    commands.moveCards([{ cardId: 'doc', x: 80, y: 90 }])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.save).toHaveLength(2)
    expect(calls.save[1]?.reason).toBe('periodic')
    expect(useWorkbenchSessionStore.getState().saveState).toBe('unsaved')
  })

  it('没有改动时不发保存请求', async () => {
    const { client, calls } = createFakeClient()
    commands = commandsFor(client)
    await commands.save('manual')
    expect(calls.save).toHaveLength(0)
    expect(toast).toHaveBeenCalledWith(workbenchFeedback.saveNoChanges)
  })

  it('首次脏后 30 秒保存，期间继续编辑不重置计时', async () => {
    vi.useFakeTimers()
    const { client, calls } = createFakeClient()
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 10, y: 10 }])
    await vi.advanceTimersByTimeAsync(10_000)
    commands.moveCards([{ cardId: 'doc', x: 20, y: 20 }])
    await vi.advanceTimersByTimeAsync(19_999)
    expect(calls.save).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await vi.runOnlyPendingTimersAsync()
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]?.reason).toBe('periodic')
    expect(useWorkbenchSessionStore.getState().saveState).toBe('saved')
  })

  it('撤销恢复本地快照，不调用版本回退', async () => {
    const { client, calls } = createFakeClient()
    commands = commandsFor(client)
    commands.moveCards([{ cardId: 'doc', x: 90, y: 90 }])
    commands.undo()
    expect(useWorkbenchSessionStore.getState().cards[0]?.layout).toMatchObject({ x: 0, y: 0 })
    expect(calls.save).toHaveLength(0)
    expect(calls.deleteCard).toBe(0)
  })

  it('历史写操作前取消延迟编辑；视图过期时挂起保存', async () => {
    vi.useFakeTimers()
    const { client, calls } = createFakeClient()
    commands = commandsFor(client)
    commands.editPromptBody('prompt', '撤销前草稿')
    await commands.prepareHistoryWrite()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.editPromptBody).toBe(0)

    commands.moveCards([{ cardId: 'doc', x: 40, y: 50 }])
    commands.setSaveHold(true)
    await commands.save('manual')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.save).toHaveLength(0)

    commands.setSaveHold(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls.save).toHaveLength(1)
    expect(calls.save[0]?.reason).toBe('periodic')
  })

  it('复制卡片时按画布放置避开源卡和相邻卡', async () => {
    let copiedLayout: { x: number; y: number; width: number; height: number } | null = null
    const client = {
      copyCard: async (request: {
        arrangement: SceneCanvasArrangementVO
        layout: { x: number; y: number; width: number; height: number }
      }) => {
        copiedLayout = request.layout
        return ok(request.arrangement)
      }
    } as unknown as SceneCanvasClient
    commands = commandsFor(client)
    expect(await commands.copyCard('doc')).toBe('applied')
    expect(copiedLayout).toEqual({ x: 696, y: 32, width: 300, height: 224 })
  })
})

describe('画布读取', () => {
  it('读取 null 是空画布，读取失败是失败状态', async () => {
    startSession()
    const emptyClient = {
      readSceneCanvasArrangement: async () => ok(null)
    } as unknown as SceneCanvasClient
    const noSources = {
      readProjectInputSources: async () => ok({ projectId: 'p-01', readVersion: 'v', sources: [] })
    } as unknown as ProjectFilesClient
    await loadArrangement(emptyClient, noSources, 'p-01')
    expect(useWorkbenchSessionStore.getState().arrangementStatus).toBe('empty')

    startSession()
    const failedClient = {
      readSceneCanvasArrangement: async () => ({ code: 4416, msg: '编排内容损坏' })
    } as unknown as SceneCanvasClient
    await loadArrangement(failedClient, noSources, 'p-01')
    const failed = useWorkbenchSessionStore.getState()
    expect(failed.arrangementStatus).toBe('failed')
    expect(failed.arrangementError?.code).toBe(4416)
    expect(failed.arrangementStatus).not.toBe('empty')
  })

  it('读取编排后按来源身份补详情，卡片正文不进入卡片', async () => {
    startSession()
    const client = {
      readSceneCanvasArrangement: async () => ok(arrangement())
    } as unknown as SceneCanvasClient
    const projectFiles = {
      readProjectInputSources: async () =>
        ok({
          projectId: 'p-01',
          readVersion: 'v1',
          sources: [
            {
              sourceId: 'doc-1',
              version: 'v1',
              contentKind: 'text',
              textKind: 'document',
              title: '角色',
              body: '# 正文',
              topics: ['角色'],
              importInfo: { format: 'markdown' }
            }
          ]
        })
    } as unknown as ProjectFilesClient
    await loadArrangement(client, projectFiles, 'p-01')
    const state = useWorkbenchSessionStore.getState()
    expect(state.arrangementStatus).toBe('ready')
    expect(state.sourceDetails['doc-1']).toMatchObject({ contentKind: 'text' })
    expect(JSON.stringify(state.cards)).not.toContain('# 正文')
  })

  it('装载时把不足 32 的卡片弹开，并只保存一次规范化结果', async () => {
    startSession()
    const tight = arrangement()
    tight.cards = tight.cards.map((card) =>
      card.cardId === 'img' ? { ...card, layout: { ...card.layout, x: 320 } } : card
    )
    const saves: SaveSceneCanvasArrangementDTO[] = []
    const client = {
      readSceneCanvasArrangement: async () => ok(tight),
      saveSceneCanvasArrangement: async (request: SaveSceneCanvasArrangementDTO) => {
        saves.push(request)
        return ok(structuredClone(request.arrangement))
      }
    } as unknown as SceneCanvasClient
    const noSources = {
      readProjectInputSources: async () => ok({ projectId: 'p-01', readVersion: 'v', sources: [] })
    } as unknown as ProjectFilesClient
    await loadArrangement(client, noSources, 'p-01')

    const state = useWorkbenchSessionStore.getState()
    expect(state.cards.find((card) => card.cardId === 'img')?.layout.x).toBe(332)
    expect(state.saveState).toBe('saved')
    expect(state.past).toHaveLength(0)
    expect(saves).toHaveLength(1)
    expect(saves[0]?.reason).toBe('periodic')
    expect(saves[0]?.arrangement.cards.find((card) => card.cardId === 'img')?.layout.x).toBe(
      332
    )
  })

  it('装载时卡片已满足间距则不发起保存', async () => {
    startSession()
    const saves: SaveSceneCanvasArrangementDTO[] = []
    const client = {
      readSceneCanvasArrangement: async () => ok(arrangement()),
      saveSceneCanvasArrangement: async (request: SaveSceneCanvasArrangementDTO) => {
        saves.push(request)
        return ok(structuredClone(request.arrangement))
      }
    } as unknown as SceneCanvasClient
    const noSources = {
      readProjectInputSources: async () => ok({ projectId: 'p-01', readVersion: 'v', sources: [] })
    } as unknown as ProjectFilesClient
    await loadArrangement(client, noSources, 'p-01')

    expect(saves).toHaveLength(0)
    expect(useWorkbenchSessionStore.getState().past).toHaveLength(0)
  })

  it('装载规范化保存失败时保留 dirty，并沿用保存失败文案', async () => {
    startSession()
    vi.mocked(toast).mockClear()
    const tight = arrangement()
    tight.cards = tight.cards.map((card) =>
      card.cardId === 'img' ? { ...card, layout: { ...card.layout, x: 320 } } : card
    )
    const client = {
      readSceneCanvasArrangement: async () => ok(tight),
      saveSceneCanvasArrangement: async () => ({ code: 4411, msg: '磁盘不可写' })
    } as unknown as SceneCanvasClient
    const noSources = {
      readProjectInputSources: async () => ok({ projectId: 'p-01', readVersion: 'v', sources: [] })
    } as unknown as ProjectFilesClient
    await loadArrangement(client, noSources, 'p-01')

    const state = useWorkbenchSessionStore.getState()
    expect(state.saveState).toBe('unsaved')
    expect(sessionIsDirty(state)).toBe(true)
    expect(state.cards.find((card) => card.cardId === 'img')?.layout.x).toBe(332)
    expect(toast).toHaveBeenCalledWith(workbenchFeedback.saveUnsaved)
  })
})

describe('工作区首次打开', () => {
  it('已就绪时用检查返回的身份读取画布，不补建', async () => {
    useWorkbenchSessionStore.getState().reset()
    const calls: string[] = []
    const projects = {
      inspectProjectWorkspace: async () => {
        calls.push('inspect')
        return ok({ ready: true, sceneId: 'scene-returned', canvasId: 'canvas-returned' })
      },
      ensureProjectWorkspace: async () => {
        calls.push('ensure')
        return ok({ projectId: 'p-01', sceneId: 'scene-ensured', canvasId: 'canvas-ensured' })
      }
    } as unknown as ProjectClient
    const canvas = {
      readSceneCanvasArrangement: async (request: { sceneId: string; canvasId: string }) => {
        calls.push(`${request.sceneId}/${request.canvasId}`)
        return ok(null)
      }
    } as unknown as SceneCanvasClient
    const files = {
      listProjectInputSources: async () =>
        ok({ projectId: 'p-01', catalogVersion: 'v', folders: [], sources: [] })
    } as unknown as ProjectFilesClient

    const opened = await openWorkbenchWorkspace(
      projects,
      canvas,
      files,
      new QueryClient(),
      'p-01',
      '未寄出的第二封信'
    )

    expect(opened).toEqual({ workspaceReady: true, loaded: true })
    expect(calls.filter((call) => call === 'inspect')).toHaveLength(1)
    expect(calls.filter((call) => call === 'ensure')).toHaveLength(0)
    expect(calls).toContain('scene-returned/canvas-returned')
    expect(useWorkbenchSessionStore.getState()).toMatchObject({
      sceneId: 'scene-returned',
      canvasId: 'canvas-returned',
      arrangementStatus: 'empty'
    })
  })

  it('已有身份但未就绪时不补建，也不读取画布', async () => {
    useWorkbenchSessionStore.getState().reset()
    const ensure = vi.fn()
    const canvas = {
      readSceneCanvasArrangement: vi.fn(async () => ok(null))
    } as unknown as SceneCanvasClient
    const files = {
      listProjectInputSources: vi.fn()
    } as unknown as ProjectFilesClient
    const projects = {
      inspectProjectWorkspace: async () =>
        ok({ ready: false, sceneId: 'scene-returned', canvasId: 'canvas-returned' }),
      ensureProjectWorkspace: ensure
    } as unknown as ProjectClient

    const opened = await openWorkbenchWorkspace(
      projects,
      canvas,
      files,
      new QueryClient(),
      'p-01',
      '未寄出的第二封信'
    )

    expect(opened).toEqual({ workspaceReady: false, loaded: false })
    expect(ensure).not.toHaveBeenCalled()
    expect(canvas.readSceneCanvasArrangement).not.toHaveBeenCalled()
    expect(files.listProjectInputSources).not.toHaveBeenCalled()
    expect(useWorkbenchSessionStore.getState().arrangementError).toEqual({
      code: PROJECT_WORKSPACE_NOT_READY_CODE,
      msg: '工程初始化未完成，请重新构建'
    })
  })

  it('没有画布身份时才补建，并用补建身份读取画布', async () => {
    useWorkbenchSessionStore.getState().reset()
    const projects = {
      inspectProjectWorkspace: async () => ok({ ready: false }),
      ensureProjectWorkspace: async () =>
        ok({ projectId: 'p-01', sceneId: 'scene-created', canvasId: 'canvas-created' })
    } as unknown as ProjectClient
    const canvas = {
      readSceneCanvasArrangement: vi.fn(async () => ok(null))
    } as unknown as SceneCanvasClient
    const files = {
      listProjectInputSources: async () =>
        ok({ projectId: 'p-01', catalogVersion: 'v', folders: [], sources: [] })
    } as unknown as ProjectFilesClient

    const opened = await openWorkbenchWorkspace(
      projects,
      canvas,
      files,
      new QueryClient(),
      'p-01',
      '未寄出的第二封信'
    )

    expect(opened.workspaceReady).toBe(true)
    expect(canvas.readSceneCanvasArrangement).toHaveBeenCalledWith(
      expect.objectContaining({ sceneId: 'scene-created', canvasId: 'canvas-created' })
    )
  })

  it('检查失败时不补建，1309 只显示安全文案', async () => {
    useWorkbenchSessionStore.getState().reset()
    const ensure = vi.fn()
    const canvas = {
      readSceneCanvasArrangement: vi.fn(async () => ok(null))
    } as unknown as SceneCanvasClient
    const files = { listProjectInputSources: vi.fn() } as unknown as ProjectFilesClient
    const projects = {
      inspectProjectWorkspace: async () => ({
        code: PROJECT_WORKSPACE_NOT_READY_CODE,
        msg: 'D:/secret/.git 损坏'
      }),
      ensureProjectWorkspace: ensure
    } as unknown as ProjectClient

    await openWorkbenchWorkspace(
      projects,
      canvas,
      files,
      new QueryClient(),
      'p-01',
      '未寄出的第二封信'
    )

    expect(ensure).not.toHaveBeenCalled()
    expect(canvas.readSceneCanvasArrangement).not.toHaveBeenCalled()
    expect(useWorkbenchSessionStore.getState().arrangementError).toEqual({
      code: PROJECT_WORKSPACE_NOT_READY_CODE,
      msg: '工程初始化未完成，请重新构建'
    })
    expect(JSON.stringify(useWorkbenchSessionStore.getState().arrangementError)).not.toContain(
      'D:/secret'
    )
  })

  it('来源读取和刷新不核对工作区', async () => {
    startSession()
    const ensure = vi.fn()
    const files = {
      ensureProjectWorkspace: ensure,
      listProjectInputSources: async () =>
        ok({ projectId: 'p-01', catalogVersion: 'v', folders: [], sources: [] }),
      readProjectInputSources: async () => ok({ projectId: 'p-01', readVersion: 'v', sources: [] })
    } as unknown as ProjectFilesClient
    const canvas = {
      readSceneCanvasArrangement: async () => ok(arrangement())
    } as unknown as SceneCanvasClient

    await refreshSources(files, new QueryClient(), 'p-01')
    await loadArrangement(canvas, files, 'p-01')
    expect(ensure).not.toHaveBeenCalled()
  })
})
