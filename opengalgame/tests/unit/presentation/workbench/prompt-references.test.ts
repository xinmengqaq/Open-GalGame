import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { SaveSceneCanvasArrangementDTO } from '@application/scene-canvas/dto/SceneCanvasDTO'
import type {
  SceneCanvasArrangementVO,
  SceneCanvasPromptCardVO
} from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import {
  createWorkbenchCommands,
  type WorkbenchCommands
} from '@presentation/features/workbench-session/workbenchCommands'
import { arrangementDraftOf } from '@presentation/features/workbench-session/workbenchSessionMapper'
import {
  sessionIsDirty,
  useWorkbenchSessionStore
} from '@presentation/features/workbench-session/workbenchSession.store'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  appendPromptReferenceId,
  promptMentionAt,
  promptReferenceCandidates,
  promptReferenceChipViews,
  promptReferenceFailureOf,
  promptReferenceIssueSummary,
  removePromptMentionText,
  removePromptReferenceIds
} from '@presentation/features/workbench-session/promptReferences'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

const layout = { x: 0, y: 0, width: 320, height: 252 }

function cards(): SessionCard[] {
  return [
    {
      kind: 'document',
      cardId: 'doc',
      sourceId: 'src-doc',
      title: '角色设定',
      summary: '',
      layout
    },
    {
      kind: 'image',
      cardId: 'sky',
      sourceId: 'src-sky',
      role: 'background',
      title: '天空图',
      summary: '夜景城市上空，开场背景',
      layout
    },
    {
      kind: 'image',
      cardId: 'hero',
      sourceId: 'src-hero',
      role: 'characterImage',
      title: '人物立绘',
      summary: '主角常服半身立绘',
      layout
    },
    {
      kind: 'audio',
      cardId: 'rain',
      sourceId: 'src-rain',
      role: 'music',
      title: '雨声',
      summary: '雨夜环境音，循环铺底',
      layout
    },
    {
      kind: 'video',
      cardId: 'clip',
      sourceId: 'src-clip',
      title: '开场视频',
      summary: '城市延时开场镜头',
      layout
    },
    {
      kind: 'animation',
      cardId: 'anim',
      webgalPreset: { command: 'setAnimation', name: 'enter' },
      layout
    },
    {
      kind: 'effect',
      cardId: 'fx',
      webgalPreset: null,
      layout
    },
    {
      kind: 'prompt',
      cardId: 'prompt',
      body: '用 @ 作背景',
      references: [],
      layout
    },
    {
      kind: 'prompt',
      cardId: 'prompt-2',
      body: '另一张提示词',
      references: [],
      layout
    }
  ]
}

function arrangement(): SceneCanvasArrangementVO {
  return {
    projectId: 'p-01',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: cards(),
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

function promptCardOf(
  stateCards: readonly SessionCard[],
  cardId = 'prompt'
): SceneCanvasPromptCardVO {
  const card = stateCards.find((item) => item.cardId === cardId)
  if (!card || card.kind !== 'prompt') throw new Error('提示词卡不存在')
  return card
}

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function createFakeClient(options?: { saveCode?: number; promptCode?: number }): {
  client: SceneCanvasClient
  calls: { editPromptBody: number; save: SaveSceneCanvasArrangementDTO[] }
} {
  const calls = { editPromptBody: 0, save: [] as SaveSceneCanvasArrangementDTO[] }
  const client = {
    editPromptBody: async (request: {
      arrangement: SceneCanvasArrangementVO
      cardId: string
      body: string
    }) => {
      calls.editPromptBody += 1
      if (options?.promptCode !== undefined) {
        return {
          code: options.promptCode,
          msg: '同一提示词不能重复引用同一卡片',
          data: undefined
        }
      }
      const next = structuredClone(request.arrangement)
      next.cards = next.cards.map((card) =>
        card.cardId === request.cardId && card.kind === 'prompt'
          ? { ...card, body: request.body }
          : card
      )
      return ok(next)
    },
    saveSceneCanvasArrangement: async (request: SaveSceneCanvasArrangementDTO) => {
      calls.save.push(request)
      if (options?.saveCode !== undefined) {
        return {
          code: options.saveCode,
          msg: '提示词引用必须是当前画布中的其他卡片'
        }
      }
      return ok(null)
    }
  } as unknown as SceneCanvasClient
  return { client, calls }
}

describe('提示词 @ 卡片引用', () => {
  describe('触发与正文替换', () => {
    it('在行首、空白或标点后识别 @ 查询，不把邮箱当引用', () => {
      expect(promptMentionAt('用 @天空图 作背景', 6)).toEqual({
        start: 2,
        end: 6,
        query: '天空图'
      })
      expect(promptMentionAt('背景，@天空', 7)).toEqual({
        start: 3,
        end: 6,
        query: '天空'
      })
      expect(promptMentionAt('用 @', 3)).toEqual({ start: 2, end: 3, query: '' })
      expect(promptMentionAt('a@b', 3)).toBeNull()
      expect(promptMentionAt('用 @天空 作背景', 9)).toBeNull()
    })

    it('选中候选后移除触发文本，不把卡片标题写进身份', () => {
      expect(removePromptMentionText('用 @天空图 作背景', { start: 2, end: 6 })).toEqual({
        value: '用 作背景',
        caret: 2
      })
      expect(removePromptMentionText('前文@天空', { start: 2, end: 5 })).toEqual({
        value: '前文',
        caret: 2
      })
    })

    it('取消浮层只移除本次触发文本并把光标复位到移除点，不插入引用', () => {
      // 取消路径与选中候选共用同一套文本语义：先按当前光标重算 mention，再只移除触发文本。
      const cancelAt = (body: string, caret: number): { value: string; caret: number } | null => {
        const mention = promptMentionAt(body, caret)
        return mention ? removePromptMentionText(body, mention) : null
      }

      expect(cancelAt('@天空', 3)).toEqual({ value: '', caret: 0 })
      expect(cancelAt('用 @天空图 作背景', 6)).toEqual({ value: '用 作背景', caret: 2 })
      expect(cancelAt('背景，@', 4)).toEqual({ value: '背景，', caret: 3 })
      expect(cancelAt('前文 @天空 后文', 6)).toEqual({ value: '前文 后文', caret: 3 })
    })
  })

  describe('候选范围与过滤', () => {
    it('只列出当前画布的其他卡片，排除自己、提示词和已引用卡片', () => {
      const candidates = promptReferenceCandidates(cards(), 'prompt', {
        referencedIds: ['sky'],
        isSourceReadable: () => true
      })
      const ids = candidates.map((candidate) => candidate.cardId)
      expect(ids).toEqual(['doc', 'hero', 'rain', 'clip', 'anim', 'fx'])
      expect(ids).not.toContain('prompt')
      expect(ids).not.toContain('prompt-2')
      expect(ids).not.toContain('sky')
    })

    it('按当前显示名、类别和素材用途过滤真实字段', () => {
      const readable = (): boolean => true
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '天空',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['sky'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '背景',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['sky'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '图片',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['sky', 'hero'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '立绘',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['hero'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '循环铺底',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['rain'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '延时',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['clip'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '动画',
          isSourceReadable: readable
        }).map((candidate) => candidate.cardId)
      ).toEqual(['anim'])
      expect(
        promptReferenceCandidates(cards(), 'prompt', {
          query: '不存在',
          isSourceReadable: readable
        })
      ).toEqual([])
    })

    it('媒体识别信息取用途说明，空说明显示未写用途而不拿角色冒充', () => {
      const candidates = promptReferenceCandidates(cards(), 'prompt', {
        isSourceReadable: () => true
      })
      const details = new Map(
        candidates.map((candidate) => [candidate.cardId, candidate.detail] as const)
      )

      expect(details.get('sky')).toBe('夜景城市上空，开场背景')
      expect(details.get('rain')).toBe('雨夜环境音，循环铺底')
      expect(details.get('clip')).toBe('城市延时开场镜头')
      expect(details.get('doc')).toBe('文档')
      expect(details.get('anim')).toBe('动画 · setAnimation')
      expect(details.get('fx')).toBe('特效')

      const blank = cards().map((card) =>
        card.kind === 'image' || card.kind === 'audio' || card.kind === 'video'
          ? { ...card, summary: '' }
          : card
      )
      const blankCandidates = promptReferenceCandidates(blank, 'prompt', {
        isSourceReadable: () => true
      })
      const blankDetails = new Map(
        blankCandidates.map((candidate) => [candidate.cardId, candidate.detail] as const)
      )
      expect(blankDetails.get('sky')).toBe('未写用途')
      expect(blankDetails.get('rain')).toBe('未写用途')
      expect(blankDetails.get('clip')).toBe('未写用途')
      expect(blankDetails.get('sky')).not.toContain('背景')
      expect(blankDetails.get('rain')).not.toContain('音乐')
    })

    it('不可读卡片不进入候选，只在已存在的引用里显示警告', () => {
      const candidates = promptReferenceCandidates(cards(), 'prompt', {
        query: '图片',
        isSourceReadable: (sourceId) => sourceId !== 'src-sky'
      })
      expect(candidates.map((candidate) => candidate.cardId)).toEqual(['hero'])
    })

    it('未知类别和重复卡片身份都不进入候选', () => {
      const document = cards()[0]
      if (!document) throw new Error('文档卡不存在')
      const unknown = {
        ...document,
        cardId: 'mystery',
        kind: 'mystery'
      } as unknown as SessionCard
      const candidates = promptReferenceCandidates(
        [document, { ...document, title: '重复身份' }, unknown],
        'prompt',
        { isSourceReadable: () => true }
      )
      expect(candidates.map((candidate) => candidate.cardId)).toEqual(['doc'])
    })

    it('追加引用身份时去重，移除时保留其余顺序', () => {
      expect(appendPromptReferenceId([{ cardId: 'sky' }], 'hero')).toEqual(['sky', 'hero'])
      expect(appendPromptReferenceId([{ cardId: 'sky' }], 'sky')).toEqual(['sky'])
      expect(removePromptReferenceIds([{ cardId: 'sky' }, { cardId: 'hero' }], ['sky'])).toEqual([
        'hero'
      ])
    })
  })

  describe('引用展示与失效状态', () => {
    it('显示名按当前卡片解析，重命名后 cardId 不变', () => {
      const prompt = { cardId: 'prompt', references: [{ cardId: 'sky' }] }
      expect(promptReferenceChipViews(cards(), prompt)[0]).toMatchObject({
        cardId: 'sky',
        displayName: '天空图',
        kind: 'image',
        tone: 'valid',
        issue: null
      })
      const renamed = cards().map((card) =>
        card.cardId === 'sky' && card.kind === 'image' ? { ...card, title: '晚霞' } : card
      )
      expect(promptReferenceChipViews(renamed, prompt)[0]).toMatchObject({
        cardId: 'sky',
        displayName: '晚霞'
      })
    })

    it('目标离开画布时保留失效状态，不按同名标题匹配替代卡片', () => {
      const sameTitle = [
        ...cards(),
        {
          kind: 'image' as const,
          cardId: 'sky-copy',
          sourceId: 'src-sky-copy',
          role: 'background' as const,
          title: '天空图',
          summary: '',
          layout
        }
      ]
      const views = promptReferenceChipViews(sameTitle, {
        cardId: 'prompt',
        references: [{ cardId: 'missing-sky' }]
      })
      expect(views[0]).toMatchObject({
        cardId: 'missing-sky',
        tone: 'invalid',
        issue: { kind: 'missing' }
      })
      expect(views[0]?.displayName).not.toBe('天空图')
    })

    it('来源不可读取、重复引用和提示词目标都有明确标记', () => {
      const unreadable = promptReferenceChipViews(
        cards(),
        { cardId: 'prompt', references: [{ cardId: 'sky' }] },
        (sourceId) => sourceId !== 'src-sky'
      )
      expect(unreadable[0]).toMatchObject({
        tone: 'warning',
        issue: { kind: 'unreadable' }
      })

      const duplicated = promptReferenceChipViews(cards(), {
        cardId: 'prompt',
        references: [{ cardId: 'sky' }, { cardId: 'sky' }]
      })
      expect(duplicated[1]?.issue).toMatchObject({ kind: 'duplicate' })

      const promptTarget = promptReferenceChipViews(cards(), {
        cardId: 'prompt',
        references: [{ cardId: 'prompt-2' }]
      })
      expect(promptTarget[0]?.issue).toMatchObject({ kind: 'promptTarget' })

      const mystery = {
        ...cards()[0],
        cardId: 'mystery',
        kind: 'mystery'
      } as unknown as SessionCard
      const unknown = promptReferenceChipViews([...cards(), mystery], {
        cardId: 'prompt',
        references: [{ cardId: 'mystery' }]
      })
      expect(unknown[0]).toMatchObject({
        tone: 'invalid',
        issue: { kind: 'unknown' }
      })
    })

    it('卡片内提示优先显示阻塞保存的问题，并提供可清理的身份', () => {
      const views = promptReferenceChipViews(cards(), {
        cardId: 'prompt',
        references: [{ cardId: 'missing-sky' }, { cardId: 'rain' }, { cardId: 'rain' }]
      })
      const summary = promptReferenceIssueSummary(views)
      expect(summary).toMatchObject({
        tone: 'danger',
        removableIds: ['missing-sky', 'rain']
      })
      expect(summary?.text).not.toMatch(/4401|4402|4101/)
    })
  })

  describe('错误码与旧记录', () => {
    it('4401、4402、4101 只做内部判别，可见文案不透出数值码', () => {
      const duplicate = promptReferenceFailureOf({
        code: 4401,
        message: '内部 4401：重复引用'
      })
      expect(duplicate).toEqual({
        text: '同一提示词不能重复引用同一卡片。'
      })
      expect(duplicate?.text).not.toMatch(/4401|4402|4101/)
      expect(
        promptReferenceFailureOf({
          code: 4402,
          message: '提示词引用必须是当前画布中的其他卡片'
        })?.text
      ).toBe('提示词引用必须是当前画布中的其他卡片。')
      expect(
        promptReferenceFailureOf({
          code: 4401,
          message: '同一编排不能重复登记同一卡片'
        })
      ).toBeNull()
      expect(
        promptReferenceFailureOf({
          code: 4101,
          message: '提示词引用的卡片不在当前画布或无法读取'
        })?.text
      ).toBe('提示词引用的卡片不在当前画布或无法读取。')
      expect(
        promptReferenceFailureOf({
          code: 4101,
          message: '同一提示词不能重复引用同一卡片'
        })?.text
      ).toBe('同一提示词不能重复引用同一卡片。')
      expect(promptReferenceFailureOf({ code: 4101, message: '请求参数无效' })).toBeNull()
      expect(promptReferenceFailureOf({ code: 9999, message: '其他失败' })).toBeNull()
    })

    it('旧提示词没有 references 时归一为空数组，保存请求仍可构造', () => {
      const legacy = arrangement() as unknown as {
        cards: Array<Record<string, unknown>>
      }
      const prompt = legacy.cards.find((card) => card.cardId === 'prompt')
      if (!prompt) throw new Error('提示词卡不存在')
      delete prompt.references
      const draft = arrangementDraftOf(legacy as unknown as SceneCanvasArrangementVO)
      expect(promptCardOf(draft.cards).references).toEqual([])
    })
  })

  describe('会话保存', () => {
    let commands: WorkbenchCommands | null = null

    beforeEach(() => {
      vi.mocked(toast).mockReset()
      startSession()
    })

    afterEach(() => {
      commands?.dispose()
      commands = null
    })

    it('选中候选后更新会话引用并随整份编排保存，不改写正文', async () => {
      const { client, calls } = createFakeClient()
      commands = createWorkbenchCommands(client)

      commands.addPromptReference('prompt', 'sky')
      await vi.waitFor(() => expect(calls.save).toHaveLength(1))

      const sent = promptCardOf(calls.save[0].arrangement.cards)
      expect(sent.references).toEqual([{ cardId: 'sky' }])
      expect(sent.body).toBe('用 @ 作背景')
      expect(promptCardOf(useWorkbenchSessionStore.getState().cards).references).toEqual([
        { cardId: 'sky' }
      ])
      expect(sessionIsDirty(useWorkbenchSessionStore.getState())).toBe(false)
    })

    it('移除引用后保存空集合，保留其他引用顺序', async () => {
      useWorkbenchSessionStore.getState().setPromptReferences('prompt', ['sky', 'hero'])
      const { client, calls } = createFakeClient()
      commands = createWorkbenchCommands(client)

      commands.removePromptReferences('prompt', ['sky'])
      await vi.waitFor(() => expect(calls.save).toHaveLength(1))
      expect(promptCardOf(calls.save[0].arrangement.cards).references).toEqual([{ cardId: 'hero' }])
    })

    it('保存返回 4402 时在会话里留下引用提示，不只 Toast', async () => {
      const { client } = createFakeClient({ saveCode: 4402 })
      commands = createWorkbenchCommands(client)

      commands.addPromptReference('prompt', 'sky')
      await vi.waitFor(() =>
        expect(useWorkbenchSessionStore.getState().promptReferenceAlert).toMatchObject({
          message: '提示词引用必须是当前画布中的其他卡片。'
        })
      )
      expect(useWorkbenchSessionStore.getState().saveError).toMatchObject({ code: 4402 })
      expect(toast).toHaveBeenCalled()
    })

    it('正文局部保存返回 4401 时把提示归到对应提示词卡', async () => {
      useWorkbenchSessionStore.getState().setPromptReferences('prompt', ['sky'])
      const { client } = createFakeClient({ promptCode: 4401 })
      commands = createWorkbenchCommands(client)

      commands.editPromptBody('prompt', '新正文')
      await commands.flushPromptEdits()
      await vi.waitFor(() =>
        expect(useWorkbenchSessionStore.getState().promptReferenceAlert).toMatchObject({
          message: '同一提示词不能重复引用同一卡片。',
          cardId: 'prompt'
        })
      )
    })

    it('旧响应不覆盖请求之后写入的引用集合', () => {
      const store = useWorkbenchSessionStore.getState()
      const capture = { revision: store.revision, structuralRevision: store.structuralRevision }
      store.setPromptReferences('prompt', ['sky'])
      store.applyServerArrangement(arrangement(), capture)
      expect(promptCardOf(useWorkbenchSessionStore.getState().cards).references).toEqual([
        { cardId: 'sky' }
      ])
    })
  })
})
